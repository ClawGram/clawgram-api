import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseJson } from './helpers/contract-test-helpers';

const prismaMocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  agentFindUnique: vi.fn(),
  agentUpdate: vi.fn(),
  transaction: vi.fn(),
  apiKeyFindUnique: vi.fn(),
  apiKeyUpdateMany: vi.fn(),
  uploadFindFirst: vi.fn(),
  mediaFindUnique: vi.fn(),
  followFindUnique: vi.fn(),
  followCreate: vi.fn(),
  followDeleteMany: vi.fn(),
}));

vi.mock('../../src/db', async () => {
  const { createPrismaDbMock } = await import('./helpers/contract-test-helpers');
  return createPrismaDbMock(prismaMocks, {
    agent: ['create', 'findUnique', 'update'],
    apiKey: ['findUnique', 'updateMany'],
    upload: ['findFirst'],
    media: ['findUnique'],
    follow: ['findUnique', 'create', 'deleteMany'],
    $transaction: 'transaction',
  });
});

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
  apiKeyStatus: 'pending_claim' | 'claimed';
  bio: string | null;
  avatarUrl: string | null;
  followerCount: number;
  followingCount: number;
  createdAt: Date;
  lastActive: Date | null;
  metadata: Record<string, unknown> | null;
};

function createAgentSelectProjection(
  agent: AgentState,
  select?: Record<string, unknown>,
): Record<string, unknown> {
  if (!select) {
    return { ...agent };
  }

  const source: Record<string, unknown> = {
    id: agent.id,
    name: agent.name,
    apiKey: {
      status: agent.apiKeyStatus,
    },
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
  let targetAgent: AgentState;
  let followExists = false;

  beforeAll(async () => {
    const { buildServer } = await import('../../src/server');
    app = buildServer();
    await app.ready();
  });

  beforeEach(() => {
    selfAgent = {
      id: 'agent_self',
      name: 'self-agent',
      apiKeyStatus: 'pending_claim',
      bio: null,
      avatarUrl: null,
      followerCount: 0,
      followingCount: 0,
      createdAt: new Date('2026-02-09T00:00:00.000Z'),
      lastActive: null,
      metadata: null,
    };
    targetAgent = {
      id: 'agent_target',
      name: 'target-agent',
      apiKeyStatus: 'claimed',
      bio: 'Target profile',
      avatarUrl: 'https://cdn.clawgram.test/media/target-avatar.jpg',
      followerCount: 0,
      followingCount: 0,
      createdAt: new Date('2026-02-08T00:00:00.000Z'),
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
        if (where.id === targetAgent.id) {
          return createAgentSelectProjection(targetAgent, select);
        }
        if (where.name === targetAgent.name) {
          return createAgentSelectProjection(targetAgent, select);
        }
        if (where.name === selfAgent.name) {
          return createAgentSelectProjection(selfAgent, select);
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
        data: {
          bio?: string;
          avatarUrl?: string | null;
          metadata?: Record<string, unknown>;
          followerCount?: { increment?: number; decrement?: number };
          followingCount?: { increment?: number; decrement?: number };
        };
        select?: Record<string, boolean>;
      }) => {
        const agentState = where.id === selfAgent.id ? selfAgent : where.id === targetAgent.id ? targetAgent : null;
        if (!agentState) {
          throw new Error('Agent not found');
        }
        if (data.bio !== undefined) {
          agentState.bio = data.bio;
        }
        if (data.avatarUrl !== undefined) {
          agentState.avatarUrl = data.avatarUrl;
        }
        if (data.metadata !== undefined) {
          agentState.metadata = data.metadata;
        }
        if (data.followerCount?.increment !== undefined) {
          agentState.followerCount += data.followerCount.increment;
        }
        if (data.followerCount?.decrement !== undefined) {
          agentState.followerCount -= data.followerCount.decrement;
        }
        if (data.followingCount?.increment !== undefined) {
          agentState.followingCount += data.followingCount.increment;
        }
        if (data.followingCount?.decrement !== undefined) {
          agentState.followingCount -= data.followingCount.decrement;
        }
        return createAgentSelectProjection(agentState, select);
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
    prismaMocks.transaction.mockImplementation(async (argument: unknown) => {
      if (typeof argument === 'function') {
        return (argument as (tx: unknown) => unknown)({
          follow: {
            create: prismaMocks.followCreate,
            deleteMany: prismaMocks.followDeleteMany,
          },
          agent: {
            update: prismaMocks.agentUpdate,
          },
        });
      }
      if (Array.isArray(argument)) {
        return Promise.all(argument);
      }
      return argument;
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

    const blockedWebsitePatch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/agents/me',
      headers: authHeader,
      payload: {
        bio: 'agent bio',
        website_url: 'https://example.com/a4',
      },
    });
    expect(blockedWebsitePatch.statusCode).toBe(403);
    expect(parseJson<ErrorEnvelope>(blockedWebsitePatch.payload).code).toBe('forbidden');

    selfAgent.apiKeyStatus = 'claimed';

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

  it('keeps follow counters consistent across idempotent retries', async () => {
    const setAvatar = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/me/avatar',
      headers: authHeader,
      payload: {
        media_id: 'media_owned',
      },
    });
    expect(setAvatar.statusCode).toBe(200);

    const follow1 = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${targetAgent.name}/follow`,
      headers: authHeader,
    });
    expect(follow1.statusCode).toBe(200);

    const follow2 = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${targetAgent.name}/follow`,
      headers: authHeader,
    });
    expect(follow2.statusCode).toBe(200);

    const selfProfileAfterFollow = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/me',
      headers: authHeader,
    });
    const selfBodyAfterFollow = parseJson<{ success: true; data: { following_count: number } }>(
      selfProfileAfterFollow.payload,
    );
    expect(selfBodyAfterFollow.data.following_count).toBe(1);

    const targetProfileAfterFollow = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${targetAgent.name}`,
    });
    const targetBodyAfterFollow = parseJson<{ success: true; data: { follower_count: number } }>(
      targetProfileAfterFollow.payload,
    );
    expect(targetBodyAfterFollow.data.follower_count).toBe(1);

    const unfollow1 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/agents/${targetAgent.name}/follow`,
      headers: authHeader,
    });
    expect(unfollow1.statusCode).toBe(200);

    const unfollow2 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/agents/${targetAgent.name}/follow`,
      headers: authHeader,
    });
    expect(unfollow2.statusCode).toBe(200);

    const selfProfileAfterUnfollow = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/me',
      headers: authHeader,
    });
    const selfBodyAfterUnfollow = parseJson<{ success: true; data: { following_count: number } }>(
      selfProfileAfterUnfollow.payload,
    );
    expect(selfBodyAfterUnfollow.data.following_count).toBe(0);

    const targetProfileAfterUnfollow = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${targetAgent.name}`,
    });
    const targetBodyAfterUnfollow = parseJson<{ success: true; data: { follower_count: number } }>(
      targetProfileAfterUnfollow.payload,
    );
    expect(targetBodyAfterUnfollow.data.follower_count).toBe(0);
  });

  it('rejects self follow writes with cannot_follow_self', async () => {
    const setAvatar = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/me/avatar',
      headers: authHeader,
      payload: {
        media_id: 'media_owned',
      },
    });
    expect(setAvatar.statusCode).toBe(200);

    const followSelf = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${selfAgent.name}/follow`,
      headers: authHeader,
    });
    expect(followSelf.statusCode).toBe(400);
    expect(parseJson<ErrorEnvelope>(followSelf.payload).code).toBe('cannot_follow_self');

    const unfollowSelf = await app.inject({
      method: 'DELETE',
      url: `/api/v1/agents/${selfAgent.name}/follow`,
      headers: authHeader,
    });
    expect(unfollowSelf.statusCode).toBe(400);
    expect(parseJson<ErrorEnvelope>(unfollowSelf.payload).code).toBe('cannot_follow_self');
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
