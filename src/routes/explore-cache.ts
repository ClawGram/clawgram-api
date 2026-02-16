import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { stripQueryString } from '../http/normalize';
import { ok } from '../response';

const CACHE_CONTROL_PUBLIC_READ = 'public, max-age=30, must-revalidate';
const CACHE_CONTROL_AUTH_READ = 'private, max-age=0, must-revalidate';

export type CacheVisibility = 'public' | 'auth';

function appendVaryHeader(existing: unknown, nextValue: string): string {
  const parts = typeof existing === 'string' ? existing.split(',').map((part) => part.trim()) : [];
  if (!parts.includes(nextValue)) {
    parts.push(nextValue);
  }
  return parts.filter((part) => part.length > 0).join(', ');
}

function normalizeEtagToken(token: string): string | '*' | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === '*') {
    return '*';
  }
  const withoutWeakPrefix = trimmed.startsWith('W/') ? trimmed.slice(2).trimStart() : trimmed;
  if (
    withoutWeakPrefix.length < 2 ||
    !withoutWeakPrefix.startsWith('"') ||
    !withoutWeakPrefix.endsWith('"')
  ) {
    return null;
  }
  return withoutWeakPrefix.slice(1, -1);
}

function parseIfNoneMatchHeader(header: string | string[] | undefined): Array<string | '*'> {
  const joined = Array.isArray(header) ? header.join(',') : header;
  if (!joined || joined.trim().length === 0) {
    return [];
  }

  const tokens: Array<string | '*'> = [];
  for (const part of joined.split(',')) {
    const normalized = normalizeEtagToken(part);
    if (normalized) {
      tokens.push(normalized);
    }
  }
  return tokens;
}

function buildWeakEtag(input: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('base64url');
  return `W/"${digest}"`;
}

function removeCursorFieldsForEtag(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => removeCursorFieldsForEtag(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'next_cursor') {
      continue;
    }
    normalized[key] = removeCursorFieldsForEtag(fieldValue);
  }
  return normalized;
}

function doesIfNoneMatchHeaderMatch(request: FastifyRequest, currentEtag: string): boolean {
  const currentToken = normalizeEtagToken(currentEtag);
  if (!currentToken || currentToken === '*') {
    return false;
  }

  const candidates = parseIfNoneMatchHeader(request.headers['if-none-match']);
  return candidates.includes('*') || candidates.includes(currentToken);
}

function applyReadCacheHeaders(
  reply: FastifyReply,
  options: {
    visibility: CacheVisibility;
    etag: string;
  },
) {
  reply.header(
    'Cache-Control',
    options.visibility === 'public' ? CACHE_CONTROL_PUBLIC_READ : CACHE_CONTROL_AUTH_READ,
  );
  reply.header('ETag', options.etag);
  if (options.visibility === 'auth') {
    reply.header('Vary', appendVaryHeader(reply.getHeader('Vary'), 'Authorization'));
  }
}

export function sendCachedReadResponse<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  options: {
    visibility: CacheVisibility;
    data: T;
    cacheContext?: string;
  },
): FastifyReply {
  const etag = buildWeakEtag({
    method: request.method.toUpperCase(),
    path: stripQueryString(request.url),
    query: request.query,
    cache_context: options.cacheContext ?? null,
    data: removeCursorFieldsForEtag(options.data),
  });
  applyReadCacheHeaders(reply, {
    visibility: options.visibility,
    etag,
  });

  if (doesIfNoneMatchHeaderMatch(request, etag)) {
    return reply.code(304).send();
  }

  return reply.code(200).send(ok(request, options.data));
}
