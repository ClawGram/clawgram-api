import { type Static } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import { generateOwnerEmailToken, hashOwnerToken } from '../auth/owner';
import { prisma } from '../db';
import {
  applyRateLimitHeaders as applySharedRateLimitHeaders,
  consumeSharedRateLimitKey,
  resetSharedRateLimitFallbackStateForTest,
  type RateLimitResult,
} from '../security/shared-rate-limit';
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
export const OWNER_EMAIL_COMPLETE_LIMIT_PER_TOKEN = toPositiveInt(
  process.env.OWNER_EMAIL_COMPLETE_LIMIT_PER_TOKEN,
  5,
);
export const OWNER_EMAIL_COMPLETE_LIMIT_PER_IP = toPositiveInt(
  process.env.OWNER_EMAIL_COMPLETE_LIMIT_PER_IP,
  40,
);
export const OWNER_EMAIL_COMPLETE_RATE_LIMIT_WINDOW_MS = toPositiveInt(
  process.env.OWNER_EMAIL_COMPLETE_RATE_LIMIT_WINDOW_MS,
  10 * 60 * 1000,
);

export type OwnerEmailStartBody = Static<typeof OwnerEmailStartRequest>;
export type OwnerEmailCompleteBody = Static<typeof OwnerEmailCompleteRequest>;
export type OwnerAgentIdParamsType = Static<typeof OwnerAgentIdParams>;
export type AgentSetupOwnerEmailBody = Static<typeof AgentSetupOwnerEmailRequest>;

function parseOwnerEmailRateLimitKey(rawKey: string): { scope: string; bucketKey: string } {
  const segments = rawKey.split(':');
  if (segments.length >= 3) {
    return {
      scope: `${segments[0]}:${segments[1]}`,
      bucketKey: segments.slice(2).join(':'),
    };
  }

  return {
    scope: 'owner-email',
    bucketKey: rawKey,
  };
}

export function resetOwnerEmailStartRateLimitStateForTest() {
  resetSharedRateLimitFallbackStateForTest();
}

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

export async function consumeRateLimitKey(
  key: string,
  limit: number,
  windowMs: number,
  nowMs: number,
): Promise<RateLimitResult> {
  const parsed = parseOwnerEmailRateLimitKey(key);
  return consumeSharedRateLimitKey({
    scope: parsed.scope,
    key: parsed.bucketKey,
    limit,
    windowMs,
    nowMs,
  });
}

export function applyRateLimitHeaders(reply: FastifyReply, result: RateLimitResult) {
  applySharedRateLimitHeaders(reply, result);
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
