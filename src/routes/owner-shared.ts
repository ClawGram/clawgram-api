import { type Static } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import { generateOwnerEmailToken, hashOwnerToken } from '../auth/owner';
import { prisma } from '../db';
import {
  AgentSetupOwnerEmailRequest,
  OwnerAgentIdParams,
  OwnerEmailCompleteRequest,
  OwnerEmailStartRequest,
} from '../schemas/owner';

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

export const OWNER_EMAIL_TOKEN_TTL_MS = toPositiveInt(
  process.env.OWNER_EMAIL_TOKEN_TTL_MS,
  15 * 60 * 1000,
);
export const OWNER_SESSION_TTL_MS = toPositiveInt(
  process.env.OWNER_SESSION_TTL_MS,
  30 * 24 * 60 * 60 * 1000,
);
export const OWNER_EMAIL_START_LIMIT_PER_EMAIL = toPositiveInt(
  process.env.OWNER_EMAIL_START_LIMIT_PER_EMAIL,
  5,
);
export const OWNER_EMAIL_START_LIMIT_PER_IP = toPositiveInt(
  process.env.OWNER_EMAIL_START_LIMIT_PER_IP,
  20,
);
export const OWNER_EMAIL_START_RATE_LIMIT_WINDOW_MS = toPositiveInt(
  process.env.OWNER_EMAIL_START_RATE_LIMIT_WINDOW_MS,
  10 * 60 * 1000,
);

export type OwnerEmailStartBody = Static<typeof OwnerEmailStartRequest>;
export type OwnerEmailCompleteBody = Static<typeof OwnerEmailCompleteRequest>;
export type OwnerAgentIdParamsType = Static<typeof OwnerAgentIdParams>;
export type AgentSetupOwnerEmailBody = Static<typeof AgentSetupOwnerEmailRequest>;

type RateLimitBucket = {
  count: number;
  resetAtMs: number;
};

type RateLimitResult = {
  limited: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterSeconds: number;
};

const ownerEmailStartBuckets = new Map<string, RateLimitBucket>();

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function profileFromOwner(owner: { id: string; email: string; createdAt: Date }) {
  return {
    id: owner.id,
    email: owner.email,
    created_at: owner.createdAt.toISOString(),
  };
}

export function hashPresentedOwnerToken(token: string): string {
  return hashOwnerToken(token.trim());
}

export function consumeRateLimitKey(
  key: string,
  limit: number,
  windowMs: number,
  nowMs: number,
): RateLimitResult {
  const current = ownerEmailStartBuckets.get(key);
  const resetAtMs = current && current.resetAtMs > nowMs ? current.resetAtMs : nowMs + windowMs;
  const bucket: RateLimitBucket =
    current && current.resetAtMs > nowMs
      ? current
      : {
          count: 0,
          resetAtMs,
        };

  if (bucket.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAtMs - nowMs) / 1000));
    ownerEmailStartBuckets.set(key, bucket);
    return {
      limited: true,
      limit,
      remaining: 0,
      resetAtMs: bucket.resetAtMs,
      retryAfterSeconds,
    };
  }

  bucket.count += 1;
  ownerEmailStartBuckets.set(key, bucket);
  return {
    limited: false,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAtMs: bucket.resetAtMs,
    retryAfterSeconds: 0,
  };
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

export async function issueOwnerEmailToken(options: {
  ownerId: string;
  requestId: string;
  email: string;
  requestedByAgentId?: string;
}) {
  const { token, tokenHash } = generateOwnerEmailToken();
  const expiresAt = new Date(Date.now() + OWNER_EMAIL_TOKEN_TTL_MS);

  await prisma.ownerEmailToken.create({
    data: {
      ownerId: options.ownerId,
      tokenHash,
      expiresAt,
      requestedByAgentId: options.requestedByAgentId,
    },
  });

  return {
    token,
    expiresAt,
  };
}
