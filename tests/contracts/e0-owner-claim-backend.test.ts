/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashApiKey } from '../../src/auth/api-key';
import { hashOwnerToken } from '../../src/auth/owner';
import {
  OWNER_EMAIL_COMPLETE_LIMIT_PER_IP,
  OWNER_EMAIL_COMPLETE_LIMIT_PER_TOKEN,
  resetOwnerEmailStartRateLimitStateForTest,
} from '../../src/routes/owner-shared';
import { parseJson } from './helpers/contract-test-helpers';

const transportState = vi.hoisted(() => ({
  deliveries: [] as Array<any>,
}));

const prismaMocks = vi.hoisted(() => ({
  ownerUpsert: vi.fn(),
  ownerFindUnique: vi.fn(),
  ownerEmailTokenCreate: vi.fn(),
  ownerEmailTokenFindUnique: vi.fn(),
  ownerEmailTokenUpdateMany: vi.fn(),
  ownerSessionCreate: vi.fn(),
  ownerSessionFindUnique: vi.fn(),
  agentOwnershipFindUnique: vi.fn(),
  agentOwnershipCreate: vi.fn(),
  agentOwnershipFindMany: vi.fn(),
  apiKeyFindUnique: vi.fn(),
  apiKeyUpdateMany: vi.fn(),
  apiKeyUpdate: vi.fn(),
  ownerApiKeyRotationCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../src/owner/email-transport', () => ({
  deliverOwnerEmailToken: vi.fn(async (_request, payload) => {
    transportState.deliveries.push(payload);
  }),
}));

vi.mock('../../src/db', async () => {
  const { createPrismaDbMock } = await import('./helpers/contract-test-helpers');
  return createPrismaDbMock(prismaMocks, {
    owner: ['upsert', 'findUnique'],
    ownerEmailToken: ['create', 'findUnique', 'updateMany'],
    ownerSession: ['create', 'findUnique'],
    agentOwnership: ['findUnique', 'create', 'findMany'],
    apiKey: ['findUnique', 'updateMany', 'update'],
    ownerApiKeyRotation: ['create'],
    $transaction: 'transaction',
  });
});

type ErrorEnvelope = {
  success: false;
  code: string;
};

describe('contract: E0 owner claim backend', () => {
  let app: FastifyInstance;

  type OwnerRecord = {
    id: string;
    email: string;
    createdAt: Date;
  };

  type OwnerTokenRecord = {
    id: string;
    ownerId: string;
    tokenHash: string;
    expiresAt: Date;
    consumedAt: Date | null;
    requestedByAgentId: string | null;
    createdAt: Date;
  };

  type OwnerSessionRecord = {
    id: string;
    ownerId: string;
    tokenHash: string;
    expiresAt: Date;
    revokedAt: Date | null;
    createdAt: Date;
  };

  type AgentOwnershipRecord = {
    id: string;
    ownerId: string;
    agentId: string;
    createdAt: Date;
  };

  type ApiKeyRecord = {
    id: string;
    agentId: string;
    keyHash: string;
    status: 'pending_claim' | 'claimed';
  };

  type AgentRecord = {
    id: string;
    name: string;
    bio: string | null;
    avatarUrl: string | null;
  };

  const ownersByEmail = new Map<string, OwnerRecord>();
  const ownersById = new Map<string, OwnerRecord>();
  const ownerTokensByHash = new Map<string, OwnerTokenRecord>();
  const ownerTokensById = new Map<string, OwnerTokenRecord>();
  const ownerSessionsByHash = new Map<string, OwnerSessionRecord>();
  const ownershipByAgentId = new Map<string, AgentOwnershipRecord>();
  const apiKeysById = new Map<string, ApiKeyRecord>();
  const apiKeysByAgentId = new Map<string, ApiKeyRecord>();
  const apiKeysByHash = new Map<string, ApiKeyRecord>();
  const agentsById = new Map<string, AgentRecord>();

  let sequence = 0;
  const nextId = (prefix: string) => {
    sequence += 1;
    return `${prefix}_${sequence}`;
  };

  const putApiKeyRecord = (record: ApiKeyRecord) => {
    apiKeysById.set(record.id, record);
    apiKeysByAgentId.set(record.agentId, record);
    apiKeysByHash.set(record.keyHash, record);
  };

  beforeAll(async () => {
    const { buildServer } = await import('../../src/server');
    app = buildServer();
    await app.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    transportState.deliveries.length = 0;
    sequence = 0;
    resetOwnerEmailStartRateLimitStateForTest();

    ownersByEmail.clear();
    ownersById.clear();
    ownerTokensByHash.clear();
    ownerTokensById.clear();
    ownerSessionsByHash.clear();
    ownershipByAgentId.clear();
    apiKeysById.clear();
    apiKeysByAgentId.clear();
    apiKeysByHash.clear();
    agentsById.clear();

    agentsById.set('agent_owned', {
      id: 'agent_owned',
      name: 'owned-agent',
      bio: 'owned bio',
      avatarUrl: 'https://cdn.example/owned.png',
    });
    agentsById.set('agent_other', {
      id: 'agent_other',
      name: 'other-agent',
      bio: 'other bio',
      avatarUrl: 'https://cdn.example/other.png',
    });

    putApiKeyRecord({
      id: 'apikey_owned',
      agentId: 'agent_owned',
      keyHash: hashApiKey('claw_test_agent_owned'),
      status: 'claimed',
    });
    putApiKeyRecord({
      id: 'apikey_other',
      agentId: 'agent_other',
      keyHash: hashApiKey('claw_test_agent_other'),
      status: 'pending_claim',
    });

    prismaMocks.ownerUpsert.mockImplementation(
      async ({ where, create }: { where: { email: string }; create: { email: string } }) => {
        const existing = ownersByEmail.get(where.email);
        if (existing) {
          return { id: existing.id };
        }
        const owner: OwnerRecord = {
          id: nextId('owner'),
          email: create.email,
          createdAt: new Date(),
        };
        ownersByEmail.set(owner.email, owner);
        ownersById.set(owner.id, owner);
        return { id: owner.id };
      },
    );

    prismaMocks.ownerFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      const owner = ownersById.get(where.id);
      if (!owner) {
        return null;
      }
      return {
        id: owner.id,
        email: owner.email,
        createdAt: owner.createdAt,
      };
    });

    prismaMocks.ownerEmailTokenCreate.mockImplementation(
      async ({ data }: { data: { ownerId: string; tokenHash: string; expiresAt: Date; requestedByAgentId?: string } }) => {
        const tokenRecord: OwnerTokenRecord = {
          id: nextId('owner_token'),
          ownerId: data.ownerId,
          tokenHash: data.tokenHash,
          expiresAt: data.expiresAt,
          consumedAt: null,
          requestedByAgentId: data.requestedByAgentId ?? null,
          createdAt: new Date(),
        };
        ownerTokensByHash.set(tokenRecord.tokenHash, tokenRecord);
        ownerTokensById.set(tokenRecord.id, tokenRecord);
        return tokenRecord;
      },
    );

    prismaMocks.ownerEmailTokenFindUnique.mockImplementation(
      async ({ where }: { where: { tokenHash: string } }) => {
        const tokenRecord = ownerTokensByHash.get(where.tokenHash);
        if (!tokenRecord) {
          return null;
        }
        const owner = ownersById.get(tokenRecord.ownerId);
        if (!owner) {
          return null;
        }
        return {
          id: tokenRecord.id,
          ownerId: tokenRecord.ownerId,
          expiresAt: tokenRecord.expiresAt,
          consumedAt: tokenRecord.consumedAt,
          requestedByAgentId: tokenRecord.requestedByAgentId,
          owner: {
            id: owner.id,
            email: owner.email,
            createdAt: owner.createdAt,
          },
        };
      },
    );

    prismaMocks.ownerEmailTokenUpdateMany.mockImplementation(
      async ({ where, data }: { where: { id: string; consumedAt: null }; data: { consumedAt: Date } }) => {
        const tokenRecord = ownerTokensById.get(where.id);
        if (!tokenRecord || tokenRecord.consumedAt !== null) {
          return { count: 0 };
        }
        tokenRecord.consumedAt = data.consumedAt;
        return { count: 1 };
      },
    );

    prismaMocks.ownerSessionCreate.mockImplementation(
      async ({ data }: { data: { ownerId: string; tokenHash: string; expiresAt: Date } }) => {
        const session: OwnerSessionRecord = {
          id: nextId('owner_session'),
          ownerId: data.ownerId,
          tokenHash: data.tokenHash,
          expiresAt: data.expiresAt,
          revokedAt: null,
          createdAt: new Date(),
        };
        ownerSessionsByHash.set(session.tokenHash, session);
        return session;
      },
    );

    prismaMocks.ownerSessionFindUnique.mockImplementation(
      async ({ where }: { where: { tokenHash: string } }) => {
        const session = ownerSessionsByHash.get(where.tokenHash);
        if (!session) {
          return null;
        }
        return {
          id: session.id,
          ownerId: session.ownerId,
          tokenHash: session.tokenHash,
          expiresAt: session.expiresAt,
          revokedAt: session.revokedAt,
        };
      },
    );

    prismaMocks.agentOwnershipFindUnique.mockImplementation(
      async ({ where }: { where: { agentId: string } }) => {
        const ownership = ownershipByAgentId.get(where.agentId);
        if (!ownership) {
          return null;
        }
        return { ownerId: ownership.ownerId };
      },
    );

    prismaMocks.agentOwnershipCreate.mockImplementation(
      async ({ data }: { data: { ownerId: string; agentId: string } }) => {
        const ownership: AgentOwnershipRecord = {
          id: nextId('ownership'),
          ownerId: data.ownerId,
          agentId: data.agentId,
          createdAt: new Date(),
        };
        ownershipByAgentId.set(ownership.agentId, ownership);
        return ownership;
      },
    );

    prismaMocks.agentOwnershipFindMany.mockImplementation(
      async ({ where }: { where: { ownerId: string } }) => {
        const rows = [...ownershipByAgentId.values()]
          .filter((ownership) => ownership.ownerId === where.ownerId)
          .map((ownership) => {
            const agent = agentsById.get(ownership.agentId);
            const apiKey = apiKeysByAgentId.get(ownership.agentId);
            return {
              createdAt: ownership.createdAt,
              agent: {
                id: ownership.agentId,
                name: agent?.name ?? 'unknown',
                bio: agent?.bio ?? null,
                avatarUrl: agent?.avatarUrl ?? null,
                apiKey: {
                  status: apiKey?.status ?? 'pending_claim',
                },
              },
            };
          });
        return rows;
      },
    );

    prismaMocks.apiKeyFindUnique.mockImplementation(
      async ({ where }: { where: { keyHash?: string; id?: string; agentId?: string } }) => {
        if (where.keyHash) {
          const record = apiKeysByHash.get(where.keyHash);
          if (!record) {
            return null;
          }
          return {
            id: record.id,
            agentId: record.agentId,
            keyHash: record.keyHash,
          };
        }

        if (where.id) {
          const record = apiKeysById.get(where.id);
          if (!record) {
            return null;
          }
          return {
            status: record.status,
          };
        }

        if (where.agentId) {
          const record = apiKeysByAgentId.get(where.agentId);
          if (!record) {
            return null;
          }
          return {
            id: record.id,
          };
        }

        return null;
      },
    );

    prismaMocks.apiKeyUpdateMany.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { agentId: string; status?: 'pending_claim' | 'claimed' };
        data: { keyHash?: string; status?: 'pending_claim' | 'claimed' };
      }) => {
        const record = apiKeysByAgentId.get(where.agentId);
        if (!record) {
          return { count: 0 };
        }

        if (where.status && record.status !== where.status) {
          return { count: 0 };
        }

        if (data.keyHash) {
          apiKeysByHash.delete(record.keyHash);
          record.keyHash = data.keyHash;
          apiKeysByHash.set(record.keyHash, record);
          return { count: 1 };
        }

        if (data.status) {
          record.status = data.status;
          return { count: 1 };
        }

        return { count: 0 };
      },
    );

    prismaMocks.apiKeyUpdate.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: { keyHash: string } }) => {
        const record = apiKeysById.get(where.id);
        if (!record) {
          throw new Error('missing api key');
        }
        apiKeysByHash.delete(record.keyHash);
        record.keyHash = data.keyHash;
        apiKeysByHash.set(record.keyHash, record);
        return { id: record.id };
      },
    );

    prismaMocks.ownerApiKeyRotationCreate.mockImplementation(
      async ({ data }: { data: { ownerId: string; agentId: string; apiKeyId: string; requestId?: string } }) => ({
        id: nextId('owner_key_rotation'),
        ownerId: data.ownerId,
        agentId: data.agentId,
        apiKeyId: data.apiKeyId,
        requestId: data.requestId,
      }),
    );

    prismaMocks.transaction.mockImplementation(async (argument: any) => {
      if (typeof argument === 'function') {
        return argument({
          ownerEmailToken: {
            updateMany: prismaMocks.ownerEmailTokenUpdateMany,
          },
          agentOwnership: {
            findUnique: prismaMocks.agentOwnershipFindUnique,
          },
          apiKey: {
            updateMany: prismaMocks.apiKeyUpdateMany,
          },
          ownerSession: {
            create: prismaMocks.ownerSessionCreate,
          },
        });
      }

      if (Array.isArray(argument)) {
        return Promise.all(argument);
      }

      return null;
    });
  });

  afterAll(async () => {
    await app.close();
  });

  async function issueOwnerSessionForEmail(email: string): Promise<string> {
    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/email/start',
      payload: { email },
    });
    expect(start.statusCode).toBe(200);

    const delivery = transportState.deliveries.at(-1);
    expect(delivery).toBeTruthy();

    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/email/complete',
      payload: { token: delivery.token },
    });
    expect(complete.statusCode).toBe(200);

    const completeBody = parseJson<{
      success: true;
      data: { owner_auth_token: string };
    }>(complete.payload);

    return completeBody.data.owner_auth_token;
  }

  it('handles owner email token issue and consume lifecycle', async () => {
    const ownerAuthToken = await issueOwnerSessionForEmail('lifecycle-owner@example.com');

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/owner/me',
      headers: {
        authorization: `Bearer ${ownerAuthToken}`,
      },
    });

    expect(me.statusCode).toBe(200);
    const meBody = parseJson<{ success: true; data: { email: string } }>(me.payload);
    expect(meBody.data.email).toBe('lifecycle-owner@example.com');
  });

  it('rejects expired owner email tokens', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/email/start',
      payload: { email: 'expired-owner@example.com' },
    });
    expect(start.statusCode).toBe(200);

    const delivery = transportState.deliveries.at(-1);
    const tokenRecord = ownerTokensByHash.get(hashOwnerToken(delivery.token));
    expect(tokenRecord).toBeTruthy();
    if (tokenRecord) {
      tokenRecord.expiresAt = new Date(Date.now() - 1000);
    }

    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/email/complete',
      payload: { token: delivery.token },
    });

    expect(complete.statusCode).toBe(400);
    expect(parseJson<ErrorEnvelope>(complete.payload).code).toBe('owner_token_expired');
  });

  it('claims linked agent after setup-owner-email completion and reflects in agent status', async () => {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/me/setup-owner-email',
      headers: {
        authorization: 'Bearer claw_test_agent_other',
      },
      payload: { email: 'linked-owner@example.com' },
    });
    expect(setup.statusCode).toBe(200);
    expect(apiKeysByAgentId.get('agent_other')?.status).toBe('pending_claim');

    const delivery = transportState.deliveries.at(-1);
    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/email/complete',
      payload: { token: delivery.token },
    });
    expect(complete.statusCode).toBe(200);
    expect(apiKeysByAgentId.get('agent_other')?.status).toBe('claimed');
    expect(apiKeysByAgentId.get('agent_owned')?.status).toBe('claimed');

    const status = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/status',
      headers: {
        authorization: 'Bearer claw_test_agent_other',
      },
    });
    expect(status.statusCode).toBe(200);
    const statusBody = parseJson<{ success: true; data: { status: string } }>(status.payload);
    expect(statusBody.data.status).toBe('claimed');
  });

  it('owner email completion without linked agent does not claim unrelated agents', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/email/start',
      payload: { email: 'no-linked-agent@example.com' },
    });
    expect(start.statusCode).toBe(200);
    expect(apiKeysByAgentId.get('agent_other')?.status).toBe('pending_claim');

    const delivery = transportState.deliveries.at(-1);
    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/email/complete',
      payload: { token: delivery.token },
    });
    expect(complete.statusCode).toBe(200);
    expect(apiKeysByAgentId.get('agent_other')?.status).toBe('pending_claim');
    expect(apiKeysByAgentId.get('agent_owned')?.status).toBe('claimed');
  });

  it('rejects replay of consumed owner email tokens', async () => {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/me/setup-owner-email',
      headers: {
        authorization: 'Bearer claw_test_agent_other',
      },
      payload: { email: 'replay-owner@example.com' },
    });
    expect(setup.statusCode).toBe(200);

    const delivery = transportState.deliveries.at(-1);
    const firstComplete = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/email/complete',
      payload: { token: delivery.token },
    });
    expect(firstComplete.statusCode).toBe(200);
    expect(apiKeysByAgentId.get('agent_other')?.status).toBe('claimed');

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/email/complete',
      payload: { token: delivery.token },
    });

    expect(replay.statusCode).toBe(409);
    expect(parseJson<ErrorEnvelope>(replay.payload).code).toBe('owner_token_consumed');
    expect(apiKeysByAgentId.get('agent_other')?.status).toBe('claimed');
  });

  it('rate limits owner email completion attempts per token fingerprint', async () => {
    for (let attempt = 0; attempt < OWNER_EMAIL_COMPLETE_LIMIT_PER_TOKEN; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/owner/email/complete',
        payload: { token: 'claw_owner_email_invalid_fixed' },
      });
      expect(response.statusCode).toBe(400);
      expect(parseJson<ErrorEnvelope>(response.payload).code).toBe('invalid_owner_token');
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/email/complete',
      payload: { token: 'claw_owner_email_invalid_fixed' },
    });

    expect(limited.statusCode).toBe(429);
    expect(parseJson<ErrorEnvelope>(limited.payload).code).toBe('rate_limited');
    expect(limited.headers['ratelimit-limit']).toBeDefined();
    expect(limited.headers['ratelimit-remaining']).toBe('0');
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('rate limits owner email completion attempts per ip across many tokens', async () => {
    for (let attempt = 0; attempt < OWNER_EMAIL_COMPLETE_LIMIT_PER_IP; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/owner/email/complete',
        payload: { token: `claw_owner_email_invalid_${attempt}` },
      });
      expect(response.statusCode).toBe(400);
      expect(parseJson<ErrorEnvelope>(response.payload).code).toBe('invalid_owner_token');
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/email/complete',
      payload: { token: 'claw_owner_email_invalid_ip_limit' },
    });

    expect(limited.statusCode).toBe(429);
    expect(parseJson<ErrorEnvelope>(limited.payload).code).toBe('rate_limited');
  });

  it('allows owner to rotate API key for owned agent', async () => {
    const ownerAuthToken = await issueOwnerSessionForEmail('rotate-owned@example.com');
    const ownerRecord = ownersByEmail.get('rotate-owned@example.com');
    expect(ownerRecord).toBeTruthy();

    ownershipByAgentId.set('agent_owned', {
      id: 'ownership_owned',
      ownerId: ownerRecord?.id ?? 'missing-owner',
      agentId: 'agent_owned',
      createdAt: new Date(),
    });

    const beforeHash = apiKeysByAgentId.get('agent_owned')?.keyHash;

    const rotate = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/agents/agent_owned/api-key/rotate',
      headers: {
        authorization: `Bearer ${ownerAuthToken}`,
      },
    });

    expect(rotate.statusCode).toBe(200);
    const rotateBody = parseJson<{ success: true; data: { api_key: string } }>(rotate.payload);
    expect(typeof rotateBody.data.api_key).toBe('string');
    expect(rotateBody.data.api_key.length).toBeGreaterThan(10);
    expect(apiKeysByAgentId.get('agent_owned')?.keyHash).not.toBe(beforeHash);
    expect(prismaMocks.ownerApiKeyRotationCreate).toHaveBeenCalledTimes(1);
  });

  it('prevents owner from rotating API key for unowned agent', async () => {
    const ownerAuthToken = await issueOwnerSessionForEmail('rotate-unowned@example.com');

    const rotate = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/agents/agent_other/api-key/rotate',
      headers: {
        authorization: `Bearer ${ownerAuthToken}`,
      },
    });

    expect(rotate.statusCode).toBe(403);
    expect(parseJson<ErrorEnvelope>(rotate.payload).code).toBe('forbidden');
  });

  it('keeps existing agent API key rotation flow working', async () => {
    const beforeHash = apiKeysByAgentId.get('agent_owned')?.keyHash;

    const rotate = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/me/api-key/rotate',
      headers: {
        authorization: 'Bearer claw_test_agent_owned',
      },
    });

    expect(rotate.statusCode).toBe(200);
    const rotateBody = parseJson<{ success: true; data: { api_key: string } }>(rotate.payload);
    expect(typeof rotateBody.data.api_key).toBe('string');
    expect(apiKeysByAgentId.get('agent_owned')?.keyHash).not.toBe(beforeHash);
    expect(prismaMocks.apiKeyUpdateMany).toHaveBeenCalledTimes(1);
  });
});
