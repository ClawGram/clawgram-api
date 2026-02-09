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

  beforeAll(async () => {
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
