import type { Prisma } from '@prisma/client';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { prisma } from '../db';

type SharedRateLimitCounter = {
  count: number;
  resetAtMs: number;
};

export type RateLimitResult = {
  limited: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterSeconds: number;
};

type ConsumeRateLimitInput = {
  scope: string;
  key: string;
  limit: number;
  windowMs: number;
  nowMs?: number;
};

type QueryRawFn = <T = unknown>(query: Prisma.Sql) => Promise<T>;

const fallbackCounters = new Map<string, SharedRateLimitCounter>();

function fallbackCounterStorageKey(scope: string, key: string, windowStartMs: number): string {
  return `${scope}:${key}:${windowStartMs}`;
}

function toPositiveInt(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export const AGENT_REGISTER_LIMIT_PER_IP = toPositiveInt(process.env.AGENT_REGISTER_LIMIT_PER_IP, 30);
export const AGENT_REGISTER_RATE_LIMIT_WINDOW_MS = toPositiveInt(
  process.env.AGENT_REGISTER_RATE_LIMIT_WINDOW_MS,
  10 * 60 * 1000,
);
export const OWNER_EMAIL_SETUP_LIMIT_PER_AGENT = toPositiveInt(
  process.env.OWNER_EMAIL_SETUP_LIMIT_PER_AGENT,
  12,
);
export const OWNER_EMAIL_SETUP_LIMIT_PER_IP = toPositiveInt(process.env.OWNER_EMAIL_SETUP_LIMIT_PER_IP, 30);
export const OWNER_EMAIL_SETUP_RATE_LIMIT_WINDOW_MS = toPositiveInt(
  process.env.OWNER_EMAIL_SETUP_RATE_LIMIT_WINDOW_MS,
  10 * 60 * 1000,
);

function toWindowStartMs(nowMs: number, windowMs: number): number {
  return nowMs - (nowMs % windowMs);
}

function toRateLimitResult(
  count: number,
  limit: number,
  nowMs: number,
  resetAtMs: number,
): RateLimitResult {
  const limited = count > limit;
  return {
    limited,
    limit,
    remaining: Math.max(0, limit - count),
    resetAtMs,
    retryAfterSeconds: limited ? Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)) : 0,
  };
}

function consumeFallbackCounter(
  scope: string,
  key: string,
  limit: number,
  nowMs: number,
  windowMs: number,
): RateLimitResult {
  const windowStartMs = toWindowStartMs(nowMs, windowMs);
  const resetAtMs = windowStartMs + windowMs;
  const storageKey = fallbackCounterStorageKey(scope, key, windowStartMs);

  const previous = fallbackCounters.get(storageKey);
  const nextCount = (previous?.count ?? 0) + 1;
  fallbackCounters.set(storageKey, {
    count: nextCount,
    resetAtMs,
  });

  // Opportunistic pruning to avoid unbounded memory if DB access is unavailable.
  if (fallbackCounters.size > 20_000) {
    for (const [candidateKey, candidate] of fallbackCounters) {
      if (candidate.resetAtMs <= nowMs) {
        fallbackCounters.delete(candidateKey);
      }
    }
  }

  return toRateLimitResult(nextCount, limit, nowMs, resetAtMs);
}

function getQueryRawFn(): QueryRawFn | null {
  const maybeQueryRaw = (prisma as unknown as { $queryRaw?: QueryRawFn }).$queryRaw;
  return typeof maybeQueryRaw === 'function' ? maybeQueryRaw.bind(prisma) : null;
}

function isMissingRateLimitTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const record = error as {
    code?: string;
    meta?: {
      code?: string;
    };
  };

  return record.code === 'P2010' && record.meta?.code === '42P01';
}

export async function consumeSharedRateLimitKey(input: ConsumeRateLimitInput): Promise<RateLimitResult> {
  const nowMs = input.nowMs ?? Date.now();
  const windowStartMs = toWindowStartMs(nowMs, input.windowMs);
  const resetAtMs = windowStartMs + input.windowMs;
  const windowStart = new Date(windowStartMs);
  const windowEnd = new Date(resetAtMs);

  const queryRaw = getQueryRawFn();
  if (!queryRaw) {
    return consumeFallbackCounter(input.scope, input.key, input.limit, nowMs, input.windowMs);
  }

  try {
    const rows = await queryRaw<Array<{ count: number }>>(PrismaNamespace.sql`
      INSERT INTO "RateLimitCounter"
        ("scope", "bucketKey", "windowStart", "windowEnd", "count", "createdAt", "updatedAt")
      VALUES
        (${input.scope}, ${input.key}, ${windowStart}, ${windowEnd}, 1, NOW(), NOW())
      ON CONFLICT ("scope", "bucketKey", "windowStart")
      DO UPDATE
      SET
        "count" = "RateLimitCounter"."count" + 1,
        "windowEnd" = EXCLUDED."windowEnd",
        "updatedAt" = NOW()
      RETURNING "count";
    `);

    const currentCount = Number(rows[0]?.count ?? 1);
    return toRateLimitResult(currentCount, input.limit, nowMs, resetAtMs);
  } catch (error) {
    if (isMissingRateLimitTableError(error)) {
      return consumeFallbackCounter(input.scope, input.key, input.limit, nowMs, input.windowMs);
    }
    throw error;
  }
}

export function applyRateLimitHeaders(reply: FastifyReply, result: RateLimitResult) {
  reply.header('RateLimit-Limit', String(result.limit));
  reply.header('RateLimit-Remaining', String(result.remaining));
  reply.header('RateLimit-Reset', String(Math.ceil(result.resetAtMs / 1000)));

  reply.header('X-RateLimit-Limit', String(result.limit));
  reply.header('X-RateLimit-Remaining', String(result.remaining));
  reply.header('X-RateLimit-Reset', String(Math.ceil(result.resetAtMs / 1000)));

  if (result.limited) {
    reply.header('Retry-After', String(result.retryAfterSeconds));
  }
}

export function resetSharedRateLimitFallbackStateForTest() {
  fallbackCounters.clear();
}
