/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashApiKey } from '../../src/auth/api-key';

const prismaMocks = vi.hoisted(() => ({
  apiKeyFindUnique: vi.fn(),
  postFindMany: vi.fn(),
  followFindMany: vi.fn(),
  agentFindUnique: vi.fn(),
  agentFindMany: vi.fn(),
  hashtagFindMany: vi.fn(),
}));

vi.mock('../../src/db', () => ({
  prisma: {
    apiKey: {
      findUnique: prismaMocks.apiKeyFindUnique,
    },
    post: {
      findMany: prismaMocks.postFindMany,
    },
    follow: {
      findMany: prismaMocks.followFindMany,
    },
    agent: {
      findUnique: prismaMocks.agentFindUnique,
      findMany: prismaMocks.agentFindMany,
    },
    hashtag: {
      findMany: prismaMocks.hashtagFindMany,
    },
  },
}));

type AgentRow = {
  id: string;
  name: string;
  avatarUrl: string | null;
  bio: string | null;
  followerCount: number;
  followingCount: number;
  claimStatus: 'pending_claim' | 'claimed';
};

type PostRow = {
  id: string;
  agentId: string;
  caption: string | null;
  altText: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  isSensitive: boolean;
  reportScore: number;
  likes: number;
  comments: number;
  hashtags: string[];
};

type HashtagRow = {
  id: string;
  tag: string;
  postCount: number;
};

function parseJson<T>(payload: string): T {
  return JSON.parse(payload) as T;
}

function containsInsensitive(value: string | null, query: string): boolean {
  if (!value) {
    return false;
  }
  return value.toLowerCase().includes(query.toLowerCase());
}

function compareByOrder(
  left: { createdAt: Date; id: string },
  right: { createdAt: Date; id: string },
  direction: 'desc' | 'asc',
): number {
  if (left.createdAt.getTime() !== right.createdAt.getTime()) {
    return direction === 'desc'
      ? right.createdAt.getTime() - left.createdAt.getTime()
      : left.createdAt.getTime() - right.createdAt.getTime();
  }
  if (left.id === right.id) {
    return 0;
  }
  return direction === 'desc' ? (left.id < right.id ? 1 : -1) : left.id < right.id ? -1 : 1;
}

function filterPostWhere(post: PostRow, where: any): boolean {
  if (!where || typeof where !== 'object') {
    return true;
  }

  if (Array.isArray(where.AND)) {
    return where.AND.every((part: any) => filterPostWhere(post, part));
  }

  if (Array.isArray(where.OR)) {
    return where.OR.some((part: any) => filterPostWhere(post, part));
  }

  if (where.deletedAt === null && post.deletedAt !== null) {
    return false;
  }

  if (typeof where.agentId === 'string' && post.agentId !== where.agentId) {
    return false;
  }
  if (where.agentId?.in && !where.agentId.in.includes(post.agentId)) {
    return false;
  }
  if (where.agentId?.notIn && where.agentId.notIn.includes(post.agentId)) {
    return false;
  }

  if (where.createdAt?.lt && !(post.createdAt.getTime() < new Date(where.createdAt.lt).getTime())) {
    return false;
  }

  if (
    where.createdAt &&
    where.createdAt instanceof Date &&
    where.id?.lt &&
    !(post.createdAt.getTime() === where.createdAt.getTime() && post.id < where.id.lt)
  ) {
    return false;
  }

  if (where.caption?.contains && !containsInsensitive(post.caption, where.caption.contains)) {
    return false;
  }

  if (where.hashtags?.some?.hashtag?.tag) {
    const hashtagClause = where.hashtags.some.hashtag.tag;
    if (typeof hashtagClause === 'string') {
      if (!post.hashtags.includes(hashtagClause)) {
        return false;
      }
    } else if (hashtagClause.contains) {
      const query = String(hashtagClause.contains).toLowerCase();
      if (!post.hashtags.some((tag) => tag.includes(query))) {
        return false;
      }
    }
  }

  return true;
}

function filterAgentWhere(agent: AgentRow, where: any): boolean {
  if (!where || typeof where !== 'object') {
    return true;
  }

  if (Array.isArray(where.AND)) {
    return where.AND.every((part: any) => filterAgentWhere(agent, part));
  }

  if (Array.isArray(where.OR)) {
    return where.OR.some((part: any) => filterAgentWhere(agent, part));
  }

  if (where.name?.contains && !containsInsensitive(agent.name, where.name.contains)) {
    return false;
  }
  if (where.bio?.contains && !containsInsensitive(agent.bio, where.bio.contains)) {
    return false;
  }
  if (where.followerCount?.lt !== undefined && !(agent.followerCount < where.followerCount.lt)) {
    return false;
  }
  if (where.followerCount !== undefined && typeof where.followerCount === 'number') {
    if (agent.followerCount !== where.followerCount) {
      return false;
    }
  }
  if (where.name !== undefined && typeof where.name === 'string' && agent.name !== where.name) {
    return false;
  }
  if (where.name?.gt !== undefined && !(agent.name > where.name.gt)) {
    return false;
  }
  if (where.id?.gt !== undefined && !(agent.id > where.id.gt)) {
    return false;
  }

  return true;
}

function filterHashtagWhere(hashtag: HashtagRow, where: any): boolean {
  if (!where || typeof where !== 'object') {
    return true;
  }
  if (Array.isArray(where.AND)) {
    return where.AND.every((part: any) => filterHashtagWhere(hashtag, part));
  }
  if (Array.isArray(where.OR)) {
    return where.OR.some((part: any) => filterHashtagWhere(hashtag, part));
  }
  if (where.tag?.contains && !containsInsensitive(hashtag.tag, where.tag.contains)) {
    return false;
  }
  if (where.tag?.gt !== undefined && !(hashtag.tag > where.tag.gt)) {
    return false;
  }
  if (typeof where.tag === 'string' && hashtag.tag !== where.tag) {
    return false;
  }
  if (where.id?.gt !== undefined && !(hashtag.id > where.id.gt)) {
    return false;
  }
  return true;
}

describe('contract: C1 wave3 feed/search surface', () => {
  let app: FastifyInstance;
  let agents: AgentRow[] = [];
  let posts: PostRow[] = [];
  let hashtags: HashtagRow[] = [];
  let followsByFollower = new Map<string, string[]>();
  let keyByHash = new Map<string, { id: string; agentId: string; status: 'pending_claim' | 'claimed' }>();

  beforeAll(async () => {
    const { buildServer } = await import('../../src/server');
    app = buildServer();
    await app.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    agents = [
      { id: 'agent_viewer', name: 'viewer', avatarUrl: 'https://cdn/viewer.png', bio: 'main viewer', followerCount: 10, followingCount: 2, claimStatus: 'claimed' },
      { id: 'agent_alt', name: 'altviewer', avatarUrl: 'https://cdn/altviewer.png', bio: 'secondary viewer', followerCount: 2, followingCount: 0, claimStatus: 'pending_claim' },
      { id: 'agent_alpha', name: 'alpha', avatarUrl: 'https://cdn/alpha.png', bio: 'alpha bio', followerCount: 50, followingCount: 10, claimStatus: 'claimed' },
      { id: 'agent_beta', name: 'beta', avatarUrl: 'https://cdn/beta.png', bio: 'beta bio', followerCount: 40, followingCount: 8, claimStatus: 'pending_claim' },
      { id: 'agent_gamma', name: 'gamma', avatarUrl: 'https://cdn/gamma.png', bio: 'gamma cats', followerCount: 30, followingCount: 4, claimStatus: 'claimed' },
      { id: 'agent_delta', name: 'delta', avatarUrl: 'https://cdn/delta.png', bio: 'delta cats', followerCount: 20, followingCount: 3, claimStatus: 'pending_claim' },
      { id: 'agent_eps', name: 'epsilon', avatarUrl: 'https://cdn/epsilon.png', bio: 'epsilon', followerCount: 15, followingCount: 2, claimStatus: 'claimed' },
      { id: 'agent_zeta', name: 'zeta', avatarUrl: 'https://cdn/zeta.png', bio: 'zeta', followerCount: 14, followingCount: 2, claimStatus: 'pending_claim' },
      { id: 'agent_eta', name: 'eta', avatarUrl: 'https://cdn/eta.png', bio: 'eta', followerCount: 13, followingCount: 2, claimStatus: 'claimed' },
      { id: 'agent_theta', name: 'theta', avatarUrl: 'https://cdn/theta.png', bio: 'theta', followerCount: 12, followingCount: 2, claimStatus: 'pending_claim' },
      { id: 'agent_iota', name: 'iota', avatarUrl: 'https://cdn/iota.png', bio: 'iota', followerCount: 11, followingCount: 2, claimStatus: 'claimed' },
      { id: 'agent_kappa', name: 'kappa', avatarUrl: 'https://cdn/kappa.png', bio: 'kappa', followerCount: 9, followingCount: 1, claimStatus: 'pending_claim' },
      { id: 'agent_lambda', name: 'lambda', avatarUrl: 'https://cdn/lambda.png', bio: 'lambda', followerCount: 8, followingCount: 1, claimStatus: 'claimed' },
    ];

    const base = new Date('2026-02-09T12:00:00.000Z').getTime();
    const makePost = (
      id: string,
      agentId: string,
      minutesAgo: number,
      likes: number,
      comments: number,
      tags: string[],
      caption: string,
    ): PostRow => ({
      id,
      agentId,
      caption,
      altText: null,
      createdAt: new Date(base - minutesAgo * 60_000),
      deletedAt: null,
      isSensitive: false,
      reportScore: 0,
      likes,
      comments,
      hashtags: tags,
    });

    posts = [
      makePost('post_01', 'agent_alpha', 1, 20, 6, ['cats', 'ai'], 'alpha cats one'),
      makePost('post_02', 'agent_alpha', 2, 19, 6, ['cats'], 'alpha cats two'),
      makePost('post_03', 'agent_alpha', 3, 18, 5, ['dogs'], 'alpha dogs'),
      makePost('post_04', 'agent_beta', 4, 17, 5, ['cats'], 'beta cats one'),
      makePost('post_05', 'agent_beta', 5, 16, 5, ['cats'], 'beta cats two'),
      makePost('post_06', 'agent_beta', 6, 15, 5, ['birds'], 'beta birds'),
      makePost('post_07', 'agent_gamma', 7, 14, 2, ['cats'], 'gamma cats'),
      makePost('post_08', 'agent_delta', 8, 13, 2, ['cats'], 'delta cats'),
      makePost('post_09', 'agent_eps', 9, 12, 2, ['nature'], 'epsilon nature'),
      makePost('post_10', 'agent_zeta', 10, 11, 2, ['nature'], 'zeta nature'),
      makePost('post_11', 'agent_eta', 11, 10, 2, ['cats'], 'eta cats'),
      makePost('post_12', 'agent_theta', 12, 9, 1, ['cats'], 'theta cats'),
      makePost('post_13', 'agent_iota', 13, 8, 1, ['wild'], 'iota wild'),
      makePost('post_14', 'agent_kappa', 14, 7, 1, ['wild'], 'kappa wild'),
      makePost('post_15', 'agent_lambda', 15, 6, 1, ['cats'], 'lambda cats'),
    ];

    hashtags = [
      { id: 'tag_cats', tag: 'cats', postCount: posts.filter((post) => post.hashtags.includes('cats')).length },
      { id: 'tag_nature', tag: 'nature', postCount: posts.filter((post) => post.hashtags.includes('nature')).length },
      { id: 'tag_dogs', tag: 'dogs', postCount: posts.filter((post) => post.hashtags.includes('dogs')).length },
      { id: 'tag_ai', tag: 'ai', postCount: posts.filter((post) => post.hashtags.includes('ai')).length },
    ];

    followsByFollower = new Map([
      ['agent_viewer', ['agent_alpha', 'agent_beta']],
      ['agent_alt', []],
    ]);

    keyByHash = new Map();
    const addKey = (raw: string, agentId: string, status: 'pending_claim' | 'claimed') => {
      keyByHash.set(hashApiKey(raw), { id: `api_${agentId}`, agentId, status });
    };
    addKey('claw_test_viewer', 'agent_viewer', 'claimed');
    addKey('claw_test_alt', 'agent_alt', 'pending_claim');

    prismaMocks.apiKeyFindUnique.mockImplementation(({ where }: { where: { keyHash?: string; id?: string } }) => {
      if (where.keyHash) {
        const found = keyByHash.get(where.keyHash);
        return found ? { id: found.id, agentId: found.agentId, keyHash: where.keyHash } : null;
      }
      if (where.id) {
        const found = [...keyByHash.values()].find((row) => row.id === where.id);
        return found ? { status: found.status } : null;
      }
      return null;
    });

    prismaMocks.followFindMany.mockImplementation(({ where }: { where: { followerId: string } }) =>
      (followsByFollower.get(where.followerId) ?? []).map((followingId) => ({ followingId })),
    );

    prismaMocks.postFindMany.mockImplementation(
      ({ where, orderBy, take }: { where: any; orderBy: Array<any>; take: number }) => {
        const filtered = posts.filter((post) => filterPostWhere(post, where));
        const sorted = [...filtered].sort((left, right) =>
          compareByOrder(left, right, orderBy[0].createdAt as 'desc' | 'asc'),
        );
        const sliced = sorted.slice(0, take);
        return sliced.map((post) => ({
          ...post,
          agent: {
            name: agents.find((agent) => agent.id === post.agentId)?.name ?? 'unknown',
            avatarUrl: agents.find((agent) => agent.id === post.agentId)?.avatarUrl ?? null,
          },
          images: [
            {
              media: {
                id: `media_${post.id}`,
                url: `https://cdn/${post.id}.jpg`,
                width: 100,
                height: 100,
                format: 'jpeg',
              },
            },
          ],
          hashtags: post.hashtags.map((tag) => ({ hashtag: { tag } })),
          _count: {
            likes: post.likes,
            comments: post.comments,
          },
        }));
      },
    );

    prismaMocks.agentFindUnique.mockImplementation(({ where }: { where: { name?: string; id?: string } }) => {
      if (where.name) {
        const agent = agents.find((row) => row.name === where.name);
        return agent ? { id: agent.id } : null;
      }
      if (where.id) {
        const agent = agents.find((row) => row.id === where.id);
        return agent ? { id: agent.id } : null;
      }
      return null;
    });

    prismaMocks.agentFindMany.mockImplementation(
      ({ where, take }: { where: any; take: number }) =>
        agents
          .filter((agent) => filterAgentWhere(agent, where))
          .sort((left, right) => {
            if (left.followerCount !== right.followerCount) {
              return right.followerCount - left.followerCount;
            }
            if (left.name !== right.name) {
              return left.name < right.name ? -1 : 1;
            }
            if (left.id === right.id) {
              return 0;
            }
            return left.id < right.id ? -1 : 1;
          })
          .slice(0, take)
          .map((agent) => ({
            id: agent.id,
            name: agent.name,
            avatarUrl: agent.avatarUrl,
            bio: agent.bio,
            followerCount: agent.followerCount,
            followingCount: agent.followingCount,
            apiKey: {
              status: agent.claimStatus,
            },
          })),
    );

    prismaMocks.hashtagFindMany.mockImplementation(
      ({ where, take }: { where: any; take: number }) =>
        hashtags
          .filter((hashtag) => filterHashtagWhere(hashtag, where))
          .sort((left, right) => {
            if (left.tag !== right.tag) {
              return left.tag < right.tag ? -1 : 1;
            }
            if (left.id === right.id) {
              return 0;
            }
            return left.id < right.id ? -1 : 1;
          })
          .slice(0, take)
          .map((hashtag) => ({
            id: hashtag.id,
            tag: hashtag.tag,
            _count: {
              posts: hashtag.postCount,
            },
          })),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('applies deterministic explore ordering with diversity cap and cursor pagination', async () => {
    const firstPage = await app.inject({
      method: 'GET',
      url: '/api/v1/explore?limit=10',
    });

    expect(firstPage.statusCode).toBe(200);
    const firstBody = parseJson<{ success: true; data: { items: Array<{ id: string; author: { name: string } }>; next_cursor?: string; has_more: boolean } }>(
      firstPage.payload,
    );
    expect(firstBody.success).toBe(true);
    expect(firstBody.data.items).toHaveLength(10);
    expect(firstBody.data.has_more).toBe(true);
    expect(typeof firstBody.data.next_cursor).toBe('string');

    const alphaCount = firstBody.data.items.filter((item) => item.author.name === 'alpha').length;
    const betaCount = firstBody.data.items.filter((item) => item.author.name === 'beta').length;
    expect(alphaCount).toBeLessThanOrEqual(1);
    expect(betaCount).toBeLessThanOrEqual(1);

    const sameRequest = await app.inject({
      method: 'GET',
      url: '/api/v1/explore?limit=10',
    });
    const sameBody = parseJson<{ success: true; data: { items: Array<{ id: string }> } }>(sameRequest.payload);
    expect(sameBody.data.items.map((item) => item.id)).toEqual(firstBody.data.items.map((item) => item.id));

    const secondPage = await app.inject({
      method: 'GET',
      url: `/api/v1/explore?limit=10&cursor=${encodeURIComponent(firstBody.data.next_cursor ?? '')}`,
    });
    expect(secondPage.statusCode).toBe(200);
    const secondBody = parseJson<{ success: true; data: { items: Array<{ id: string }> } }>(secondPage.payload);
    const firstIds = new Set(firstBody.data.items.map((item) => item.id));
    expect(secondBody.data.items.some((item) => firstIds.has(item.id))).toBe(false);
  });

  it('returns following feed with best-effort 80/20 blend and explore backfill', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/feed?limit=10',
      headers: { authorization: 'Bearer claw_test_viewer' },
    });

    expect(response.statusCode).toBe(200);
    const body = parseJson<{ success: true; data: { items: Array<{ author: { name: string } }>; has_more: boolean } }>(
      response.payload,
    );
    const followedNames = new Set(['alpha', 'beta']);
    const followedCount = body.data.items.filter((item) => followedNames.has(item.author.name)).length;
    expect(followedCount).toBeGreaterThanOrEqual(6);
    expect(body.data.items.length - followedCount).toBeGreaterThan(0);
    expect(body.data.has_more).toBe(true);

    const noFollowResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/feed?limit=5',
      headers: { authorization: 'Bearer claw_test_alt' },
    });
    expect(noFollowResponse.statusCode).toBe(200);
    const noFollowBody = parseJson<{ success: true; data: { items: Array<{ id: string }>; has_more: boolean } }>(
      noFollowResponse.payload,
    );
    expect(noFollowBody.data.items.length).toBeGreaterThan(0);
    expect(noFollowBody.data.has_more).toBe(true);
  });

  it('supports hashtag feed and profile post grid cursor pagination', async () => {
    const tagPage1 = await app.inject({
      method: 'GET',
      url: '/api/v1/hashtags/cats/feed?limit=2',
    });
    expect(tagPage1.statusCode).toBe(200);
    const tagBody1 = parseJson<{ success: true; data: { items: Array<{ id: string; created_at: string }>; next_cursor?: string } }>(
      tagPage1.payload,
    );
    expect(tagBody1.data.items).toHaveLength(2);
    expect(typeof tagBody1.data.next_cursor).toBe('string');
    expect(new Date(tagBody1.data.items[0].created_at).getTime()).toBeGreaterThanOrEqual(
      new Date(tagBody1.data.items[1].created_at).getTime(),
    );

    const tagPage2 = await app.inject({
      method: 'GET',
      url: `/api/v1/hashtags/cats/feed?limit=2&cursor=${encodeURIComponent(tagBody1.data.next_cursor ?? '')}`,
    });
    expect(tagPage2.statusCode).toBe(200);
    const tagBody2 = parseJson<{ success: true; data: { items: Array<{ id: string }> } }>(tagPage2.payload);
    const firstIds = new Set(tagBody1.data.items.map((item) => item.id));
    expect(tagBody2.data.items.some((item) => firstIds.has(item.id))).toBe(false);

    const profilePage = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/alpha/posts?limit=3',
    });
    expect(profilePage.statusCode).toBe(200);
    const profileBody = parseJson<{ success: true; data: { items: Array<{ author: { name: string } }> } }>(
      profilePage.payload,
    );
    expect(profileBody.data.items.every((item) => item.author.name === 'alpha')).toBe(true);

    const missingProfile = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/does-not-exist/posts',
    });
    expect(missingProfile.statusCode).toBe(404);
    expect(parseJson<{ code: string }>(missingProfile.payload).code).toBe('not_found');
  });

  it('implements unified search with type buckets and per-bucket cursors', async () => {
    const tooShort = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=a',
    });
    expect(tooShort.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(tooShort.payload).code).toBe('validation_error');

    const postsSearch = await app.inject({
      method: 'GET',
      url: '/api/v1/search?type=posts&q=cats&limit=2',
    });
    expect(postsSearch.statusCode).toBe(200);
    const postsBody = parseJson<{ success: true; data: { type: string; items: Array<{ id: string }>; next_cursor?: string } }>(
      postsSearch.payload,
    );
    expect(postsBody.data.type).toBe('posts');
    expect(postsBody.data.items).toHaveLength(2);
    expect(typeof postsBody.data.next_cursor).toBe('string');

    const postsSearchPage2 = await app.inject({
      method: 'GET',
      url: `/api/v1/search?type=posts&q=cats&limit=2&cursor=${encodeURIComponent(postsBody.data.next_cursor ?? '')}`,
    });
    expect(postsSearchPage2.statusCode).toBe(200);
    const postsBody2 = parseJson<{ success: true; data: { items: Array<{ id: string }> } }>(postsSearchPage2.payload);
    const firstIds = new Set(postsBody.data.items.map((item) => item.id));
    expect(postsBody2.data.items.some((item) => firstIds.has(item.id))).toBe(false);

    const allSearch = await app.inject({
      method: 'GET',
      url: '/api/v1/search?type=all&q=cats&agents_limit=1&hashtags_limit=1&posts_limit=2',
    });
    expect(allSearch.statusCode).toBe(200);
    const allBody = parseJson<{
      success: true;
      data: {
        type: string;
        agents: { items: Array<{ name: string }>; next_cursor?: string };
        hashtags: { items: Array<{ tag: string }>; next_cursor?: string };
        posts: { items: Array<{ id: string }>; next_cursor?: string };
      };
    }>(allSearch.payload);
    expect(allBody.data.type).toBe('all');
    expect(allBody.data.agents.items.length).toBeLessThanOrEqual(1);
    expect(allBody.data.hashtags.items.length).toBeLessThanOrEqual(1);
    expect(allBody.data.posts.items.length).toBeLessThanOrEqual(2);
  });

  it('returns validation_error for malformed cursors and invalid query combinations on wave3 reads', async () => {
    const malformedCursor = '%%%';
    const longCursor = 'a'.repeat(5000);

    const exploreMalformed = await app.inject({
      method: 'GET',
      url: `/api/v1/explore?cursor=${encodeURIComponent(malformedCursor)}`,
    });
    expect(exploreMalformed.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(exploreMalformed.payload).code).toBe('validation_error');

    const exploreLongCursor = await app.inject({
      method: 'GET',
      url: `/api/v1/explore?cursor=${encodeURIComponent(longCursor)}`,
    });
    expect(exploreLongCursor.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(exploreLongCursor.payload).code).toBe('validation_error');

    const feedMalformed = await app.inject({
      method: 'GET',
      url: `/api/v1/feed?cursor=${encodeURIComponent(malformedCursor)}`,
      headers: { authorization: 'Bearer claw_test_viewer' },
    });
    expect(feedMalformed.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(feedMalformed.payload).code).toBe('validation_error');

    const hashtagMalformed = await app.inject({
      method: 'GET',
      url: `/api/v1/hashtags/cats/feed?cursor=${encodeURIComponent(malformedCursor)}`,
    });
    expect(hashtagMalformed.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(hashtagMalformed.payload).code).toBe('validation_error');

    const profileMalformed = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/alpha/posts?cursor=${encodeURIComponent(malformedCursor)}`,
    });
    expect(profileMalformed.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(profileMalformed.payload).code).toBe('validation_error');

    const searchAgentsMalformed = await app.inject({
      method: 'GET',
      url: `/api/v1/search?type=agents&q=cat&cursor=${encodeURIComponent(malformedCursor)}`,
    });
    expect(searchAgentsMalformed.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(searchAgentsMalformed.payload).code).toBe('validation_error');

    const searchHashtagsMalformed = await app.inject({
      method: 'GET',
      url: `/api/v1/search?type=hashtags&q=cat&cursor=${encodeURIComponent(malformedCursor)}`,
    });
    expect(searchHashtagsMalformed.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(searchHashtagsMalformed.payload).code).toBe('validation_error');

    const searchPostsMalformed = await app.inject({
      method: 'GET',
      url: `/api/v1/search?type=posts&q=cat&cursor=${encodeURIComponent(malformedCursor)}`,
    });
    expect(searchPostsMalformed.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(searchPostsMalformed.payload).code).toBe('validation_error');

    const searchAllMalformed = await app.inject({
      method: 'GET',
      url: `/api/v1/search?type=all&q=cat&posts_cursor=${encodeURIComponent(malformedCursor)}`,
    });
    expect(searchAllMalformed.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(searchAllMalformed.payload).code).toBe('validation_error');

    const searchLimitInvalid = await app.inject({
      method: 'GET',
      url: '/api/v1/search?type=posts&q=cat&limit=0',
    });
    expect(searchLimitInvalid.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(searchLimitInvalid.payload).code).toBe('validation_error');

    const searchAllLimitInvalid = await app.inject({
      method: 'GET',
      url: '/api/v1/search?type=all&q=cat&posts_limit=0',
    });
    expect(searchAllLimitInvalid.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(searchAllLimitInvalid.payload).code).toBe('validation_error');
  });
});
