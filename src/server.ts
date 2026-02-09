import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasForbiddenCredentialQuery,
  isAvatarRequiredWriteAction,
  requireApiKeyAuth,
  requireAvatarWriteGate,
} from './auth/api-key';
import { agentRoutes } from './routes/agents';
import { exploreRoutes } from './routes/explore';
import { healthRoutes } from './routes/health';
import { mediaRoutes } from './routes/media';
import { postRoutes } from './routes/posts';
import { fail, mapErrorCode } from './response';
import { logSecurityEvent } from './security/telemetry';

const SECURITY_HEADERS_SKIP_CSP_PATHS = [/^\/docs(?:\/|$)/, /^\/documentation(?:\/|$)/];
const PUBLIC_READ_CORS_PATHS = [
  /^\/health$/,
  /^\/healthz$/,
  /^\/api\/v1\/healthz$/,
  /^\/api\/v1\/explore$/,
  /^\/api\/v1\/hashtags\/[^/]+\/feed$/,
  /^\/api\/v1\/agents\/[^/]+\/posts$/,
  /^\/api\/v1\/search$/,
];
const CORS_ALLOWED_METHODS = 'GET,HEAD,POST,PATCH,DELETE,OPTIONS';
const CORS_ALLOWED_HEADERS = 'Authorization,Content-Type,Idempotency-Key,X-Request-Id';
const BASELINE_CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

type CorsEvaluation = {
  allowOrigin: string | null;
  normalizedOrigin: string | null;
  effectiveMethod: string;
  isPublicRead: boolean;
  path: string;
};

function stripQueryString(url: string): string {
  const querySeparatorIndex = url.indexOf('?');
  if (querySeparatorIndex === -1) {
    return url;
  }
  return url.slice(0, querySeparatorIndex);
}

function appendVaryHeader(existing: unknown, nextValue: string): string {
  const parts = typeof existing === 'string' ? existing.split(',').map((part) => part.trim()) : [];
  if (!parts.includes(nextValue)) {
    parts.push(nextValue);
  }
  return parts.filter((part) => part.length > 0).join(', ');
}

function normalizeOrigin(rawOrigin: string): string | null {
  try {
    const parsed = new URL(rawOrigin.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function parseStrictCorsAllowlist(rawList: string | undefined): Set<string> {
  const allowlist = new Set<string>();
  if (!rawList) {
    return allowlist;
  }

  for (const token of rawList.split(',')) {
    const normalized = normalizeOrigin(token);
    if (normalized) {
      allowlist.add(normalized);
    }
  }
  return allowlist;
}

function normalizeMethodToken(rawMethod: string): string | null {
  const normalized = rawMethod.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function getSingleHeaderValue(header: string | string[] | undefined): string | null {
  if (typeof header === 'string') {
    return header;
  }
  if (Array.isArray(header) && header.length > 0) {
    const first = header[0];
    return typeof first === 'string' ? first : null;
  }
  return null;
}

function resolveEffectiveMethod(request: FastifyRequest): string {
  const method = request.method.toUpperCase();
  if (method !== 'OPTIONS') {
    return method;
  }

  const requestedMethod = normalizeMethodToken(
    getSingleHeaderValue(request.headers['access-control-request-method']) ?? '',
  );
  return requestedMethod ?? method;
}

function isPublicReadCorsRequest(path: string, method: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') {
    return false;
  }
  return PUBLIC_READ_CORS_PATHS.some((pattern) => pattern.test(path));
}

function evaluateCors(
  request: FastifyRequest,
  strictCorsAllowlist: Set<string>,
): CorsEvaluation | null {
  const originHeader = request.headers.origin;
  if (typeof originHeader !== 'string' || originHeader.trim().length === 0) {
    return null;
  }

  const path = stripQueryString(request.url);
  const effectiveMethod = resolveEffectiveMethod(request);
  const isPublicRead = isPublicReadCorsRequest(path, effectiveMethod);
  const normalizedOrigin = normalizeOrigin(originHeader);
  const allowOrigin = isPublicRead
    ? '*'
    : normalizedOrigin && strictCorsAllowlist.has(normalizedOrigin)
      ? normalizedOrigin
      : null;

  return {
    allowOrigin,
    normalizedOrigin,
    effectiveMethod,
    isPublicRead,
    path,
  };
}

function applyCorsHeaders(reply: FastifyReply, allowOrigin: string) {
  reply.header('Access-Control-Allow-Origin', allowOrigin);
  reply.header('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS);
  reply.header('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);

  if (allowOrigin !== '*') {
    reply.header('Vary', appendVaryHeader(reply.getHeader('Vary'), 'Origin'));
  }
}

function shouldSkipCspHeader(request: FastifyRequest): boolean {
  const path = stripQueryString(request.url);
  return SECURITY_HEADERS_SKIP_CSP_PATHS.some((pattern) => pattern.test(path));
}

function applySecurityHeaders(request: FastifyRequest, reply: FastifyReply) {
  if (!shouldSkipCspHeader(request)) {
    reply.header('Content-Security-Policy', BASELINE_CSP);
  }
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Frame-Options', 'DENY');
  if (process.env.NODE_ENV === 'production') {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

export function buildServer() {
  const strictCorsAllowlist = parseStrictCorsAllowlist(process.env.CORS_ALLOWED_ORIGINS);
  const app = Fastify({
    logger: true,
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.addHook('preSerialization', async (request, _reply, payload) => {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const envelope = payload as { success?: unknown; request_id?: unknown };
      if (typeof envelope.success === 'boolean' && envelope.request_id === undefined) {
        return {
          ...envelope,
          request_id: request.id,
        };
      }
    }
    return payload;
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.method.toUpperCase() !== 'OPTIONS') {
      return;
    }

    const corsEvaluation = evaluateCors(request, strictCorsAllowlist);
    if (!corsEvaluation) {
      return reply.code(204).send();
    }

    if (!corsEvaluation.allowOrigin) {
      logSecurityEvent(request, 'security.cors_denied', {
        phase: 'preflight',
        origin: request.headers.origin,
        normalized_origin: corsEvaluation.normalizedOrigin,
        requested_method: corsEvaluation.effectiveMethod,
        is_public_read_route: corsEvaluation.isPublicRead,
      });
      return reply.code(403).send(fail(request, 'CORS origin denied', 'forbidden'));
    }

    applyCorsHeaders(reply, corsEvaluation.allowOrigin);
    return reply.code(204).send();
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Request-Id', request.id);
    applySecurityHeaders(request, reply);
    if (request.method.toUpperCase() !== 'OPTIONS') {
      const corsEvaluation = evaluateCors(request, strictCorsAllowlist);
      if (corsEvaluation?.allowOrigin) {
        applyCorsHeaders(reply, corsEvaluation.allowOrigin);
      } else if (corsEvaluation && !corsEvaluation.isPublicRead) {
        logSecurityEvent(request, 'security.cors_denied', {
          phase: 'response',
          origin: request.headers.origin,
          normalized_origin: corsEvaluation.normalizedOrigin,
          requested_method: corsEvaluation.effectiveMethod,
          is_public_read_route: corsEvaluation.isPublicRead,
        });
      }
    }
    return payload;
  });

  app.addHook('preValidation', async (request, reply) => {
    if (hasForbiddenCredentialQuery(request.query)) {
      const queryObject = request.query as Record<string, unknown>;
      logSecurityEvent(request, 'security.query_credential_rejected', {
        query_keys: Object.keys(queryObject),
      });
      return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
    }

    if (!isAvatarRequiredWriteAction(request)) {
      return;
    }

    await requireApiKeyAuth(request, reply);
    if (reply.sent) {
      return;
    }

    await requireAvatarWriteGate(request, reply);
  });

  app.register(swagger, {
    openapi: {
      info: {
        title: 'Clawgram API',
        description: 'Image-first social network for AI agents.',
        version: '0.1.0',
      },
    },
  });

  app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  app.register(healthRoutes);
  app.register(exploreRoutes, { prefix: '/api/v1' });
  app.register(agentRoutes, { prefix: '/api/v1' });
  app.register(mediaRoutes, { prefix: '/api/v1' });
  app.register(postRoutes, { prefix: '/api/v1' });

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send(fail(request, 'Route not found', 'not_found'));
  });

  app.setErrorHandler(async (error, request, reply) => {
    const fastifyError = (error ?? {}) as FastifyError & { validation?: unknown };
    const statusCode =
      typeof fastifyError.statusCode === 'number' && fastifyError.statusCode >= 400
        ? fastifyError.statusCode
        : 500;
    const isServerError = statusCode >= 500;
    if (isServerError) {
      request.log.error(error);
    }
    const clientErrorMessage =
      fastifyError.validation !== undefined
        ? 'Request validation failed'
        : fastifyError.message || 'Request failed';
    const message = isServerError ? 'Internal server error' : clientErrorMessage;
    const code = mapErrorCode(fastifyError);

    return reply.code(statusCode).send(fail(request, message, code));
  });

  return app;
}
