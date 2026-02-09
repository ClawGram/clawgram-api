import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db';
import { fail } from '../response';

const API_KEY_BYTES = 32;
const LIVE_API_KEY_PREFIX = 'claw_live_';
const TEST_API_KEY_PREFIX = 'claw_test_';
const FORBIDDEN_QUERY_CREDENTIAL_KEYS = new Set([
  'api_key',
  'apikey',
  'apiKey',
  'access_token',
  'authorization',
]);

type AuthenticatedAgent = {
  agentId: string;
  apiKeyId: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    authAgent?: AuthenticatedAgent;
  }
}

function getApiKeyPepper(): string {
  return process.env.API_KEY_PEPPER ?? 'clawgram_dev_pepper';
}

function getApiKeyPrefix(): string {
  return process.env.NODE_ENV === 'production' ? LIVE_API_KEY_PREFIX : TEST_API_KEY_PREFIX;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function parseBearerApiKey(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const trimmed = authorizationHeader.trim();
  const bearerPrefixMatch = /^Bearer\s+/i.exec(trimmed);
  if (!bearerPrefixMatch) {
    return null;
  }

  const apiKey = trimmed.slice(bearerPrefixMatch[0].length).trim();
  return apiKey.length > 0 ? apiKey : null;
}

export function hashApiKey(apiKey: string): string {
  return createHmac('sha256', getApiKeyPepper()).update(apiKey).digest('hex');
}

export function generateApiKey(): { apiKey: string; keyHash: string } {
  const secret = randomBytes(API_KEY_BYTES).toString('base64url');
  const apiKey = `${getApiKeyPrefix()}${secret}`;
  return {
    apiKey,
    keyHash: hashApiKey(apiKey),
  };
}

export async function requireApiKeyAuth(request: FastifyRequest, reply: FastifyReply) {
  const presentedApiKey = parseBearerApiKey(request.headers.authorization);
  if (!presentedApiKey) {
    return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
  }

  const presentedHash = hashApiKey(presentedApiKey);
  const apiKeyRecord = await prisma.apiKey.findUnique({
    where: { keyHash: presentedHash },
    select: {
      id: true,
      agentId: true,
      keyHash: true,
    },
  });

  const fallbackHash = hashApiKey('claw_invalid_api_key_fallback');
  const storedHash = apiKeyRecord?.keyHash ?? fallbackHash;
  const hashMatches = constantTimeEqual(presentedHash, storedHash);

  if (!hashMatches || !apiKeyRecord) {
    return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
  }

  request.authAgent = {
    agentId: apiKeyRecord.agentId,
    apiKeyId: apiKeyRecord.id,
  };
}

export function hasForbiddenCredentialQuery(query: unknown): boolean {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    return false;
  }

  const queryKeys = Object.keys(query as Record<string, unknown>);
  return queryKeys.some((key) => {
    if (FORBIDDEN_QUERY_CREDENTIAL_KEYS.has(key)) {
      return true;
    }
    return FORBIDDEN_QUERY_CREDENTIAL_KEYS.has(key.toLowerCase());
  });
}
