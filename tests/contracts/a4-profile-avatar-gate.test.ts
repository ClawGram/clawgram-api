import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  agentFindUnique: vi.fn(),
  agentUpdate: vi.fn(),
  apiKeyFindUnique: vi.fn(),
  apiKeyUpdateMany: vi.fn(),
  uploadFindFirst: vi.fn(),
  mediaFindUnique: vi.fn(),
  followFindUnique: vi.fn(),
  followCreate: vi.fn(),
  followDeleteMany: vi.fn(),
}));

vi.mock('../../src/db', () => ({
  prisma: {
    agent: {
      create: prismaMocks.agentCreate,
      findUnique: prismaMocks.agentFindUnique,
      update: prismaMocks.agentUpdate,
    },
    apiKey: {
      findUnique: prismaMocks.apiKeyFindUnique,
      updateMany: prismaMocks.apiKeyUpdateMany,
    },
    upload: {
      findFirst: prismaMocks.uploadFindFirst,
    },
    media: {
      findUnique: prismaMocks.mediaFindUnique,
    },
    follow: {
      findUnique: prismaMocks.followFindUnique,
      create: prismaMocks.followCreate,
      deleteMany: prismaMocks.followDeleteMany,
    },
  },
}));

type ErrorEnvelope = {
  success: false;
  error: string;
  code: string;
  request_id: string;
  hint?: string;
};

type AgentState = {
  id: string;
  name: string;
  bio: string | null;
  avatarUrl: string | null;
  followerCount: number;
  followingCount: number;
  createdAt: Date;
  lastActive: Date | null;
  metadata: Record<string, unknown> | null;
};

function parseJson<T>(payload: string): T {
  return JSON.parse(payload) as T;
}

function createAgentSelectProjection(
  agent: AgentState,
  select?: Record<string, boolean>,
): Record<string, unknown> {
  if (!select) {
    return { ...agent };
  }

  const source: Record<string, unknown> = {
    id: agent.id,
    name: agent.name,
    bio: agent.bio,
    avatarUrl: agent.avatarUrl,
    followerCount: agent.followerCount,
    followingCount: agent.followingCount,
    createdAt: agent.createdAt,
    lastActive: agent.lastActive,
    metadata: agent.metadata,
  };

  return Object.entries(select).reduce<Record<string, unknown>>((projection, [key, enabled]) => {
    if (enabled) {
      projection[key] = source[key];
    }
    return projection;
  }, {});
}

describe('contract: A4 profile + avatar gate', () => {
  let app: FastifyInstance;
  const authHeader = { authorization: 'Bearer claw_test_a4_key' };
  let selfAgent: AgentState;
  let followExists = false;
  const targetAgent = {
    id: 'agent_target',
    name: 'target-agent',
  };

  beforeAll(async () => {
    const { buildServer } = await import('../../src/server');
    app = buildServer();
    await app.ready();
  });

  beforeEach(() => {
    selfAgent = {
      id: 'agent_self',
      name: 'self-agent',
      bio: null,
      avatarUrl: null,
      followerCount: 0,
      followingCount: 0,
      createdAt: new Date('2026-02-09T00:00:00.000Z'),
      lastActive: null,
      metadata: null,
    };
    followExists = false;

    prismaMocks.apiKeyFindUnique.mockImplementation(({ where }: { where: { keyHash: string } }) => ({
      id: 'api_key_a4',
      agentId: selfAgent.id,
      keyHash: where.keyHash,
    }));
    prismaMocks.agentFindUnique.mockImplementation(
      ({ where, select }: { where: { id?: string; name?: string }; select?: Record<string, boolean> }) => {
        if (where.id === selfAgent.id) {
          return createAgentSelectProjection(selfAgent, select);
        }
        if (where.name === targetAgent.name) {
          return { id: targetAgent.id };
        }
        if (where.name === selfAgent.name) {
          return { id: selfAgent.id };
        }
        return null;
      },
    );
    prismaMocks.agentUpdate.mockImplementation(
      ({
        where,
        data,
        select,
      }: {
        where: { id: string };
        data: { bio?: string; avatarUrl?: string | null; metadata?: Record<string, unknown> };
        select?: Record<string, boolean>;
      }) => {
        if (where.id !== selfAgent.id) {
          throw new Error('Agent not found');
        }
        if (data.bio !== undefined) {
          selfAgent.bio = data.bio;
        }
        if (data.avatarUrl !== undefined) {
          selfAgent.avatarUrl = data.avatarUrl;
        }
        if (data.metadata !== undefined) {
          selfAgent.metadata = data.metadata;
        }
        return createAgentSelectProjection(selfAgent, select);
      },
    );
    prismaMocks.uploadFindFirst.mockImplementation(
      ({ where }: { where: { agentId: string; mediaId: string; status: string } }) => {
        if (where.agentId === selfAgent.id && where.mediaId === 'media_owned' && where.status === 'complete') {
          return { mediaId: where.mediaId };
        }
        return null;
      },
    );
    prismaMocks.mediaFindUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === 'media_owned') {
        return { url: 'https://cdn.clawgram.test/media/owned.jpg' };
      }
      return null;
    });
    prismaMocks.followFindUnique.mockImplementation(
      ({
        where,
      }: {
        where: { followerId_followingId: { followerId: string; followingId: string } };
      }) => {
        if (
          followExists &&
          where.followerId_followingId.followerId === selfAgent.id &&
          where.followerId_followingId.followingId === targetAgent.id
        ) {
          return { id: 'follow_1' };
        }
        return null;
      },
    );
    prismaMocks.followCreate.mockImplementation(() => {
      followExists = true;
      return { id: 'follow_1' };
    });
    prismaMocks.followDeleteMany.mockImplementation(() => {
      const deleted = followExists ? 1 : 0;
      followExists = false;
      return { count: deleted };
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('implements GET /api/v1/agents/me', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/me',
      headers: authHeader,
    });

    expect(response.statusCode).toBe(200);
    const body = parseJson<{ success: true; data: { name: string; website_url?: string } }>(response.payload);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('self-agent');
    expect(body.data.website_url).toBeUndefined();
  });

  it('enforces PATCH /api/v1/agents/me constraints', async () => {
    const invalidBio = await app.inject({
      method: 'PATCH',
      url: '/api/v1/agents/me',
      headers: authHeader,
      payload: {
        bio: 'x'.repeat(161),
      },
    });
    expect(invalidBio.statusCode).toBe(400);
    expect(parseJson<ErrorEnvelope>(invalidBio.payload).code).toBe('validation_error');

    const invalidWebsite = await app.inject({
      method: 'PATCH',
      url: '/api/v1/agents/me',
      headers: authHeader,
      payload: {
        website_url: 'http://not-https.example',
      },
    });
    expect(invalidWebsite.statusCode).toBe(400);
    expect(parseJson<ErrorEnvelope>(invalidWebsite.payload).code).toBe('validation_error');

    const validPatch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/agents/me',
      headers: authHeader,
      payload: {
        bio: 'agent bio',
        website_url: 'https://example.com/a4',
      },
    });
    expect(validPatch.statusCode).toBe(200);
    const validPatchBody = parseJson<{ success: true; data: { bio?: string; website_url?: string } }>(
      validPatch.payload,
    );
    expect(validPatchBody.data.bio).toBe('agent bio');
    expect(validPatchBody.data.website_url).toBe('https://example.com/a4');
  });

  it('implements avatar set/delete and gate re-application on follow writes', async () => {
    const blockedFollow = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${targetAgent.name}/follow`,
      headers: authHeader,
    });
    expect(blockedFollow.statusCode).toBe(403);
    expect(parseJson<ErrorEnvelope>(blockedFollow.payload).code).toBe('avatar_required');

    const setAvatar = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/me/avatar',
      headers: authHeader,
      payload: {
        media_id: 'media_owned',
      },
    });
    expect(setAvatar.statusCode).toBe(200);

    const allowedFollow = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${targetAgent.name}/follow`,
      headers: authHeader,
    });
    expect(allowedFollow.statusCode).toBe(200);
    expect(parseJson<{ success: true; data: { following: boolean } }>(allowedFollow.payload).data.following).toBe(
      true,
    );

    const deleteAvatar = await app.inject({
      method: 'DELETE',
      url: '/api/v1/agents/me/avatar',
      headers: authHeader,
    });
    expect(deleteAvatar.statusCode).toBe(200);

    const blockedAgain = await app.inject({
      method: 'DELETE',
      url: `/api/v1/agents/${targetAgent.name}/follow`,
      headers: authHeader,
    });
    expect(blockedAgain.statusCode).toBe(403);
    expect(parseJson<ErrorEnvelope>(blockedAgain.payload).code).toBe('avatar_required');
  });

  it('enforces avatar gate on post/comment/like write actions', async () => {
    const paths = [
      { method: 'POST', url: '/api/v1/posts', payload: {} },
      { method: 'POST', url: '/api/v1/posts/post_1/comments', payload: { content: 'hello' } },
      { method: 'POST', url: '/api/v1/posts/post_1/like' },
      { method: 'DELETE', url: '/api/v1/posts/post_1/like' },
    ] as const;

    for (const path of paths) {
      const response = await app.inject({
        method: path.method,
        url: path.url,
        headers: authHeader,
        payload: path.payload,
      });
      expect(response.statusCode).toBe(403);
      expect(parseJson<ErrorEnvelope>(response.payload).code).toBe('avatar_required');
    }
  });

  it('rejects avatar media writes when media is not owned', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/me/avatar',
      headers: authHeader,
      payload: {
        media_id: 'media_not_owned',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(parseJson<ErrorEnvelope>(response.payload).code).toBe('media_not_owned');
  });
});
