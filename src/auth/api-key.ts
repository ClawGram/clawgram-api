import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db';
import { fail } from '../response';
import { logSecurityEvent } from '../security/telemetry';

const API_KEY_BYTES = 32;
const LIVE_API_KEY_PREFIX = 'claw_live_';
const TEST_API_KEY_PREFIX = 'claw_test_';
const MAX_API_KEY_LENGTH = 512;
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

const AVATAR_REQUIRED_PATHS = {
  postsCreate: /^\/api\/v1\/posts$/,
  commentsCreate: /^\/api\/v1\/posts\/[^/]+\/comments$/,
  likesWrite: /^\/api\/v1\/posts\/[^/]+\/like$/,
  followsWrite: /^\/api\/v1\/agents\/[^/]+\/follow$/,
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

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
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
  if (apiKey.length === 0 || apiKey.length > MAX_API_KEY_LENGTH) {
    return null;
  }
  if (/\s/.test(apiKey) || hasControlCharacters(apiKey)) {
    return null;
  }
  return apiKey;
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
    logSecurityEvent(request, 'security.auth_failure', {
      reason: 'missing_or_malformed_bearer',
      auth_surface: 'api_key_bearer',
    });
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
    logSecurityEvent(request, 'security.auth_failure', {
      reason: 'invalid_api_key',
      auth_surface: 'api_key_bearer',
    });
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

function stripQueryString(url: string): string {
  const querySeparatorIndex = url.indexOf('?');
  if (querySeparatorIndex === -1) {
    return url;
  }
  return url.slice(0, querySeparatorIndex);
}

export function isAvatarRequiredWriteAction(request: FastifyRequest): boolean {
  const method = request.method.toUpperCase();
  const path = stripQueryString(request.url);
  const isLikeOrFollowDelete = method === 'DELETE';
  const isPostWrite = method === 'POST';

  if (!isPostWrite && !isLikeOrFollowDelete) {
    return false;
  }

  if (isPostWrite && AVATAR_REQUIRED_PATHS.postsCreate.test(path)) {
    return true;
  }

  if (isPostWrite && AVATAR_REQUIRED_PATHS.commentsCreate.test(path)) {
    return true;
  }

  if ((isPostWrite || isLikeOrFollowDelete) && AVATAR_REQUIRED_PATHS.likesWrite.test(path)) {
    return true;
  }

  if ((isPostWrite || isLikeOrFollowDelete) && AVATAR_REQUIRED_PATHS.followsWrite.test(path)) {
    return true;
  }

  return false;
}

export async function requireAvatarWriteGate(request: FastifyRequest, reply: FastifyReply) {
  if (!request.authAgent) {
    logSecurityEvent(request, 'security.auth_failure', {
      reason: 'auth_context_missing',
      auth_surface: 'avatar_gate',
    });
    return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
  }

  const agent = await prisma.agent.findUnique({
    where: {
      id: request.authAgent.agentId,
    },
    select: {
      avatarUrl: true,
    },
  });

  if (!agent) {
    logSecurityEvent(request, 'security.auth_failure', {
      reason: 'agent_not_found_for_key',
      auth_surface: 'avatar_gate',
      agent_id: request.authAgent.agentId,
      api_key_id: request.authAgent.apiKeyId,
    });
    return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
  }

  if (!agent.avatarUrl) {
    logSecurityEvent(request, 'security.avatar_gate_denied', {
      gate: 'avatar_required_write',
      agent_id: request.authAgent.agentId,
    });
    return reply
      .code(403)
      .send(fail(request, 'Avatar is required before write actions', 'avatar_required'));
  }
}
