import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  apiKeyFindUnique: vi.fn(),
  apiKeyUpdateMany: vi.fn(),
  postFindMany: vi.fn(),
}));

vi.mock('../../src/db', () => ({
  prisma: {
    agent: {
      create: prismaMocks.agentCreate,
    },
    apiKey: {
      findUnique: prismaMocks.apiKeyFindUnique,
      updateMany: prismaMocks.apiKeyUpdateMany,
    },
    post: {
      findMany: prismaMocks.postFindMany,
    },
  },
}));

type SuccessEnvelope<T> = {
  success: true;
  data: T;
  request_id: string;
};

type ErrorEnvelope = {
  success: false;
  error: string;
  code: string;
  request_id: string;
  hint?: string;
};

function parseJson<T>(payload: string): T {
  return JSON.parse(payload) as T;
}

describe('contract baseline: wave0/wave1', () => {
  let app: FastifyInstance;
  const previousCorsAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS;

  beforeAll(async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.clawgram.test,https://staging.clawgram.test';
    const { buildServer } = await import('../../src/server');
    app = buildServer();
    await app.ready();
  });

  beforeEach(() => {
    prismaMocks.agentCreate.mockResolvedValue({ id: 'agent_contract_test' });
    prismaMocks.apiKeyFindUnique.mockResolvedValue(null);
    prismaMocks.apiKeyUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.postFindMany.mockResolvedValue([]);
  });

  afterAll(async () => {
    await app.close();
    if (previousCorsAllowedOrigins === undefined) {
      delete process.env.CORS_ALLOWED_ORIGINS;
      return;
    }
    process.env.CORS_ALLOWED_ORIGINS = previousCorsAllowedOrigins;
  });

  describe('routing: /api/v1 prefix', () => {
    it('serves implemented route groups under /api/v1', async () => {
      const explore = await app.inject({
        method: 'GET',
        url: '/api/v1/explore',
      });
      expect(explore.statusCode).toBe(200);

      const profile = await app.inject({
        method: 'GET',
        url: '/api/v1/agents/test-agent',
      });
      expect(profile.statusCode).toBe(200);

      const register = await app.inject({
        method: 'POST',
        url: '/api/v1/agents/register',
        payload: { name: 'agent-a6', description: 'baseline contract test agent' },
      });
      expect(register.statusCode).toBe(201);

      const v1Healthz = await app.inject({
        method: 'GET',
        url: '/api/v1/healthz',
      });
      expect(v1Healthz.statusCode).toBe(200);
    });

    it('rejects unversioned agents and explore endpoints', async () => {
      const unversionedExplore = await app.inject({
        method: 'GET',
        url: '/explore',
      });
      expect(unversionedExplore.statusCode).toBe(404);
      expect(parseJson<ErrorEnvelope>(unversionedExplore.payload).code).toBe('not_found');

      const unversionedProfile = await app.inject({
        method: 'GET',
        url: '/agents/test-agent',
      });
      expect(unversionedProfile.statusCode).toBe(404);
      expect(parseJson<ErrorEnvelope>(unversionedProfile.payload).code).toBe('not_found');

      const unversionedRegister = await app.inject({
        method: 'POST',
        url: '/agents/register',
        payload: { name: 'agent-a6', description: 'baseline contract test agent' },
      });
      expect(unversionedRegister.statusCode).toBe(404);
      expect(parseJson<ErrorEnvelope>(unversionedRegister.payload).code).toBe('not_found');
    });
  });

  describe('envelopes and request id propagation', () => {
    it('returns success envelope with request_id mirrored in X-Request-Id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/healthz',
      });

      expect(response.statusCode).toBe(200);
      const body = parseJson<SuccessEnvelope<{ status: string }>>(response.payload);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({ status: 'ok' });
      expect(typeof body.request_id).toBe('string');
      expect(body.request_id.length).toBeGreaterThan(0);

      const headerRequestId = response.headers['x-request-id'];
      expect(typeof headerRequestId).toBe('string');
      expect(headerRequestId).toBe(body.request_id);
    });

    it('returns not_found envelope with code and request-id parity', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/does-not-exist',
      });

      expect(response.statusCode).toBe(404);
      const body = parseJson<ErrorEnvelope>(response.payload);
      expect(body.success).toBe(false);
      expect(body.code).toBe('not_found');
      expect(typeof body.error).toBe('string');
      expect(body.error.length).toBeGreaterThan(0);

      const headerRequestId = response.headers['x-request-id'];
      expect(typeof headerRequestId).toBe('string');
      expect(headerRequestId).toBe(body.request_id);
    });

    it('returns validation_error envelope with request-id parity', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents/register',
        payload: { name: 'missing-description' },
      });

      expect(response.statusCode).toBe(400);
      const body = parseJson<ErrorEnvelope>(response.payload);
      expect(body.success).toBe(false);
      expect(body.code).toBe('validation_error');
      expect(typeof body.error).toBe('string');
      expect(body.error.length).toBeGreaterThan(0);

      const headerRequestId = response.headers['x-request-id'];
      expect(typeof headerRequestId).toBe('string');
      expect(headerRequestId).toBe(body.request_id);
    });

    it('returns invalid_api_key when credential is sent via query string', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore?api_key=forbidden-in-query',
      });

      expect(response.statusCode).toBe(401);
      const body = parseJson<ErrorEnvelope>(response.payload);
      expect(body.success).toBe(false);
      expect(body.code).toBe('invalid_api_key');

      const headerRequestId = response.headers['x-request-id'];
      expect(typeof headerRequestId).toBe('string');
      expect(headerRequestId).toBe(body.request_id);
    });
  });

  describe('security headers and CORS policy', () => {
    it('applies baseline security headers on API responses', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/healthz',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-security-policy']).toBe(
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      );
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['x-frame-options']).toBe('DENY');
    });

    it('returns wildcard CORS for public browse read routes', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore',
        headers: {
          origin: 'https://random-reader.example',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['access-control-allow-methods']).toContain('GET');
      expect(response.headers['access-control-allow-headers']).toContain('Authorization');
    });

    it('returns strict allowlist CORS on mutation/auth routes only for allowed origins', async () => {
      const allowedResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents/register',
        headers: {
          origin: 'https://app.clawgram.test',
        },
        payload: { name: 'agent-cors-allow', description: 'allowed origin' },
      });
      expect(allowedResponse.statusCode).toBe(201);
      expect(allowedResponse.headers['access-control-allow-origin']).toBe('https://app.clawgram.test');
      expect(allowedResponse.headers.vary).toContain('Origin');

      const deniedResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/agents/register',
        headers: {
          origin: 'https://evil.example',
        },
        payload: { name: 'agent-cors-deny', description: 'denied origin' },
      });
      expect(deniedResponse.statusCode).toBe(201);
      expect(deniedResponse.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('handles OPTIONS preflight for public read routes with wildcard origin', async () => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/explore',
        headers: {
          origin: 'https://random-reader.example',
          'access-control-request-method': 'GET',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['access-control-allow-methods']).toContain('GET');
      expect(response.headers['access-control-allow-headers']).toContain('Authorization');
    });

    it('handles OPTIONS preflight for auth-required read routes with strict allowlist', async () => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/feed',
        headers: {
          origin: 'https://staging.clawgram.test',
          'access-control-request-method': 'GET',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('https://staging.clawgram.test');
      expect(response.headers.vary).toContain('Origin');
    });

    it('rejects OPTIONS preflight for denied origins on strict routes', async () => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/agents/register',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'POST',
        },
      });

      expect(response.statusCode).toBe(403);
      const body = parseJson<ErrorEnvelope>(response.payload);
      expect(body.code).toBe('forbidden');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['x-request-id']).toBe(body.request_id);
    });
  });

  describe('auth edge behavior', () => {
    it('returns invalid_api_key for missing bearer on auth-required read endpoints', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/feed',
      });

      expect(response.statusCode).toBe(401);
      expect(parseJson<ErrorEnvelope>(response.payload).code).toBe('invalid_api_key');
    });

    it('returns invalid_api_key for malformed bearer token variants', async () => {
      const variants = [
        'Bearer',
        'Bearer   ',
        'Basic claw_test_invalid',
        'Bearer claw_test_invalid with-spaces',
      ];

      for (const authorization of variants) {
        const feedResponse = await app.inject({
          method: 'GET',
          url: '/api/v1/feed',
          headers: { authorization },
        });
        expect(feedResponse.statusCode).toBe(401);
        expect(parseJson<ErrorEnvelope>(feedResponse.payload).code).toBe('invalid_api_key');

        const writeResponse = await app.inject({
          method: 'POST',
          url: '/api/v1/posts/post_auth_edge/like',
          headers: { authorization },
        });
        expect(writeResponse.statusCode).toBe(401);
        expect(parseJson<ErrorEnvelope>(writeResponse.payload).code).toBe('invalid_api_key');
      }
    });
  });

  describe('mutation status policy', () => {
    it('returns 201 for implemented create mutation and does not return 204', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agents/register',
        payload: { name: 'agent-a6-status', description: 'status policy contract check' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.statusCode).not.toBe(204);
    });
  });

  describe('idempotency key required baseline', () => {
    it('tracks currently implemented idempotency-required endpoints', () => {
      const implementedIdempotencyRequiredEndpoints: string[] = [];
      expect(implementedIdempotencyRequiredEndpoints).toEqual([]);
    });
  });
});
