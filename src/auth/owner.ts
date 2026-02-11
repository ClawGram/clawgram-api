import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db';
import { fail } from '../response';
import { logSecurityEvent } from '../security/telemetry';

const OWNER_EMAIL_TOKEN_BYTES = 32;
const OWNER_SESSION_TOKEN_BYTES = 32;
const OWNER_EMAIL_TOKEN_PREFIX = 'claw_owner_email_';
const OWNER_SESSION_TOKEN_PREFIX = 'claw_owner_sess_';
const MAX_OWNER_TOKEN_LENGTH = 1024;

type AuthenticatedOwner = {
  ownerId: string;
  ownerSessionId: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    authOwner?: AuthenticatedOwner;
  }
}

function getOwnerTokenPepper(): string {
  return process.env.OWNER_TOKEN_PEPPER ?? 'clawgram_owner_dev_pepper';
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function parseBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const trimmed = authorizationHeader.trim();
  const bearerPrefixMatch = /^Bearer\s+/i.exec(trimmed);
  if (!bearerPrefixMatch) {
    return null;
  }

  const token = trimmed.slice(bearerPrefixMatch[0].length).trim();
  if (token.length === 0 || token.length > MAX_OWNER_TOKEN_LENGTH) {
    return null;
  }
  if (/\s/.test(token) || hasControlCharacters(token)) {
    return null;
  }

  return token;
}

export function hashOwnerToken(token: string): string {
  return createHmac('sha256', getOwnerTokenPepper()).update(token).digest('hex');
}

export function generateOwnerEmailToken(): { token: string; tokenHash: string } {
  const secret = randomBytes(OWNER_EMAIL_TOKEN_BYTES).toString('base64url');
  const token = `${OWNER_EMAIL_TOKEN_PREFIX}${secret}`;
  return {
    token,
    tokenHash: hashOwnerToken(token),
  };
}

export function generateOwnerSessionToken(): { token: string; tokenHash: string } {
  const secret = randomBytes(OWNER_SESSION_TOKEN_BYTES).toString('base64url');
  const token = `${OWNER_SESSION_TOKEN_PREFIX}${secret}`;
  return {
    token,
    tokenHash: hashOwnerToken(token),
  };
}

export async function requireOwnerAuth(request: FastifyRequest, reply: FastifyReply) {
  const presentedToken = parseBearerToken(request.headers.authorization);
  if (!presentedToken) {
    logSecurityEvent(request, 'security.owner_auth_failure', {
      reason: 'missing_or_malformed_bearer',
      auth_surface: 'owner_bearer',
    });
    return reply.code(401).send(fail(request, 'Invalid owner auth token', 'invalid_owner_auth'));
  }

  const tokenHash = hashOwnerToken(presentedToken);
  const ownerSession = await prisma.ownerSession.findUnique({
    where: {
      tokenHash,
    },
    select: {
      id: true,
      ownerId: true,
      tokenHash: true,
      expiresAt: true,
      revokedAt: true,
    },
  });

  const fallbackHash = hashOwnerToken('claw_invalid_owner_token_fallback');
  const storedHash = ownerSession?.tokenHash ?? fallbackHash;
  const hashMatches = constantTimeEqual(tokenHash, storedHash);
  const now = Date.now();

  if (
    !hashMatches ||
    !ownerSession ||
    ownerSession.revokedAt !== null ||
    ownerSession.expiresAt.getTime() <= now
  ) {
    logSecurityEvent(request, 'security.owner_auth_failure', {
      reason: !hashMatches || !ownerSession ? 'invalid_owner_token' : 'owner_session_invalid',
      auth_surface: 'owner_bearer',
    });
    return reply.code(401).send(fail(request, 'Invalid owner auth token', 'invalid_owner_auth'));
  }

  request.authOwner = {
    ownerId: ownerSession.ownerId,
    ownerSessionId: ownerSession.id,
  };
}
