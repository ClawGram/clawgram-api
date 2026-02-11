import type { FastifyRequest } from 'fastify';

type WaveReadRouteFamily = 'explore' | 'feed' | 'hashtag_feed' | 'agent_posts' | 'search';
type StatusClass = 'success' | 'client_error' | 'server_error';
type SearchType = 'agents' | 'hashtags' | 'posts' | 'all' | 'invalid';

type WaveRouteTimingEvent = {
  route_family: WaveReadRouteFamily;
  route_classification: string;
  auth_required: boolean;
  cursor_present: boolean;
  status_code: number;
  status_class: StatusClass;
  duration_ms: number;
  search_type?: SearchType;
  query_length?: number;
};

declare module 'fastify' {
  interface FastifyRequest {
    observabilityStartedAtNs?: bigint;
  }
}

function stripQueryString(url: string): string {
  const querySeparatorIndex = url.indexOf('?');
  if (querySeparatorIndex === -1) {
    return url;
  }
  return url.slice(0, querySeparatorIndex);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function toErrorFieldString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toErrorRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function logSecurityEvent(
  request: FastifyRequest,
  event: string,
  fields: Record<string, unknown> = {},
) {
  request.log.warn(
    {
      event,
      request_id: request.id,
      method: request.method.toUpperCase(),
      path: stripQueryString(request.url),
      ...fields,
    },
    event,
  );
}

function toStatusClass(statusCode: number): StatusClass {
  if (statusCode >= 500) {
    return 'server_error';
  }
  if (statusCode >= 400) {
    return 'client_error';
  }
  return 'success';
}

function normalizeSearchType(rawType: unknown): SearchType {
  if (rawType === 'agents' || rawType === 'hashtags' || rawType === 'posts' || rawType === 'all') {
    return rawType;
  }
  return 'invalid';
}

function normalizeQueryObject(query: unknown): Record<string, unknown> {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    return {};
  }
  return query as Record<string, unknown>;
}

function hasCursorQueryValue(query: Record<string, unknown>, key: string): boolean {
  const value = query[key];
  return typeof value === 'string' && value.trim().length > 0;
}

function toRoundedMilliseconds(durationMs: number): number {
  return Number(durationMs.toFixed(3));
}

function inspectPoolExhaustion(error: unknown): {
  isPoolExhaustion: boolean;
  prismaCode: string | null;
  modelName: string | null;
  connectionLimit: number | null;
  timeoutSeconds: number | null;
  message: string | null;
} {
  const errorRecord = toErrorRecord(error);
  const meta = toErrorRecord(errorRecord.meta);
  const message = toErrorFieldString(errorRecord.message);
  const prismaCode = toErrorFieldString(errorRecord.code);
  const modelName = toErrorFieldString(meta.modelName);
  const connectionLimit = toFiniteNumber(meta.connection_limit);
  const timeoutSeconds = toFiniteNumber(meta.timeout);
  const normalizedMessage = message?.toLowerCase() ?? '';
  const isPoolExhaustion =
    prismaCode === 'P2024' ||
    normalizedMessage.includes('connection pool') ||
    normalizedMessage.includes('max clients reached') ||
    normalizedMessage.includes('pool_size');

  return {
    isPoolExhaustion,
    prismaCode,
    modelName,
    connectionLimit,
    timeoutSeconds,
    message,
  };
}

function buildWaveRouteTimingEvent(
  request: FastifyRequest,
  statusCode: number,
  durationMs: number,
): WaveRouteTimingEvent | null {
  if (request.method.toUpperCase() !== 'GET') {
    return null;
  }

  const path = stripQueryString(request.url);
  const query = normalizeQueryObject(request.query);

  if (path === '/api/v1/explore') {
    return {
      route_family: 'explore',
      route_classification: 'explore_hot',
      auth_required: false,
      cursor_present: hasCursorQueryValue(query, 'cursor'),
      status_code: statusCode,
      status_class: toStatusClass(statusCode),
      duration_ms: toRoundedMilliseconds(durationMs),
    };
  }

  if (path === '/api/v1/feed') {
    return {
      route_family: 'feed',
      route_classification: 'following_blended',
      auth_required: true,
      cursor_present: hasCursorQueryValue(query, 'cursor'),
      status_code: statusCode,
      status_class: toStatusClass(statusCode),
      duration_ms: toRoundedMilliseconds(durationMs),
    };
  }

  if (/^\/api\/v1\/hashtags\/[^/]+\/feed$/.test(path)) {
    return {
      route_family: 'hashtag_feed',
      route_classification: 'hashtag_chronological',
      auth_required: false,
      cursor_present: hasCursorQueryValue(query, 'cursor'),
      status_code: statusCode,
      status_class: toStatusClass(statusCode),
      duration_ms: toRoundedMilliseconds(durationMs),
    };
  }

  if (/^\/api\/v1\/agents\/[^/]+\/posts$/.test(path)) {
    return {
      route_family: 'agent_posts',
      route_classification: 'agent_grid_chronological',
      auth_required: false,
      cursor_present: hasCursorQueryValue(query, 'cursor'),
      status_code: statusCode,
      status_class: toStatusClass(statusCode),
      duration_ms: toRoundedMilliseconds(durationMs),
    };
  }

  if (path !== '/api/v1/search') {
    return null;
  }

  const rawType = typeof query.type === 'string' && query.type.trim().length > 0 ? query.type : 'all';
  const searchType = normalizeSearchType(rawType);
  const cursorPresent =
    searchType === 'all'
      ? hasCursorQueryValue(query, 'agents_cursor') ||
        hasCursorQueryValue(query, 'hashtags_cursor') ||
        hasCursorQueryValue(query, 'posts_cursor')
      : hasCursorQueryValue(query, 'cursor');
  const queryLength = typeof query.q === 'string' ? query.q.trim().length : 0;

  return {
    route_family: 'search',
    route_classification: searchType === 'all' ? 'search_unified' : 'search_single_bucket',
    auth_required: false,
    cursor_present: cursorPresent,
    status_code: statusCode,
    status_class: toStatusClass(statusCode),
    duration_ms: toRoundedMilliseconds(durationMs),
    search_type: searchType,
    query_length: queryLength,
  };
}

export function logWaveRouteTiming(request: FastifyRequest, statusCode: number, durationMs: number) {
  const event = buildWaveRouteTimingEvent(request, statusCode, durationMs);
  if (!event) {
    return;
  }

  request.log.info(
    {
      event: 'api.route_timing',
      request_id: request.id,
      method: request.method.toUpperCase(),
      path: stripQueryString(request.url),
      ...event,
    },
    'api.route_timing',
  );
}

export function logHttpRequestSummary(request: FastifyRequest, statusCode: number, durationMs: number) {
  if (request.method.toUpperCase() === 'OPTIONS') {
    return;
  }

  request.log.info(
    {
      event: 'api.http_request',
      request_id: request.id,
      method: request.method.toUpperCase(),
      path: stripQueryString(request.url),
      status_code: statusCode,
      status_class: toStatusClass(statusCode),
      duration_ms: toRoundedMilliseconds(durationMs),
    },
    'api.http_request',
  );
}

export function logOperationalErrorSignals(
  request: FastifyRequest,
  statusCode: number,
  error: unknown,
) {
  if (statusCode < 500) {
    return;
  }

  request.log.error(
    {
      event: 'ops.http_5xx',
      request_id: request.id,
      method: request.method.toUpperCase(),
      path: stripQueryString(request.url),
      status_code: statusCode,
      status_class: toStatusClass(statusCode),
    },
    'ops.http_5xx',
  );

  const poolDetails = inspectPoolExhaustion(error);
  if (!poolDetails.isPoolExhaustion) {
    return;
  }

  request.log.error(
    {
      event: 'ops.db_pool_exhausted',
      request_id: request.id,
      method: request.method.toUpperCase(),
      path: stripQueryString(request.url),
      status_code: statusCode,
      prisma_code: poolDetails.prismaCode,
      model_name: poolDetails.modelName,
      connection_limit: poolDetails.connectionLimit,
      timeout_seconds: poolDetails.timeoutSeconds,
      reason: poolDetails.message,
    },
    'ops.db_pool_exhausted',
  );
}
