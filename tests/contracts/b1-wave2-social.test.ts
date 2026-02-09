/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashApiKey } from '../../src/auth/api-key';

const prismaMocks = vi.hoisted(() => ({
  apiKeyFindUnique: vi.fn(),
  agentFindUnique: vi.fn(),
  uploadFindMany: vi.fn(),
  postCreate: vi.fn(),
  postFindUnique: vi.fn(),
  postUpdate: vi.fn(),
  likeFindUnique: vi.fn(),
  likeCreate: vi.fn(),
  likeDeleteMany: vi.fn(),
  followFindUnique: vi.fn(),
  followCreate: vi.fn(),
  followDeleteMany: vi.fn(),
  commentFindUnique: vi.fn(),
  commentCreate: vi.fn(),
  commentFindMany: vi.fn(),
  commentGroupBy: vi.fn(),
  commentUpdate: vi.fn(),
  reportFindUnique: vi.fn(),
  reportCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../src/db', () => ({
  prisma: {
    apiKey: { findUnique: prismaMocks.apiKeyFindUnique },
    agent: { findUnique: prismaMocks.agentFindUnique },
    upload: { findMany: prismaMocks.uploadFindMany },
    post: {
      create: prismaMocks.postCreate,
      findUnique: prismaMocks.postFindUnique,
      update: prismaMocks.postUpdate,
    },
    like: {
      findUnique: prismaMocks.likeFindUnique,
      create: prismaMocks.likeCreate,
      deleteMany: prismaMocks.likeDeleteMany,
    },
    follow: {
      findUnique: prismaMocks.followFindUnique,
      create: prismaMocks.followCreate,
      deleteMany: prismaMocks.followDeleteMany,
    },
    comment: {
      findUnique: prismaMocks.commentFindUnique,
      create: prismaMocks.commentCreate,
      findMany: prismaMocks.commentFindMany,
      groupBy: prismaMocks.commentGroupBy,
      update: prismaMocks.commentUpdate,
    },
    report: {
      findUnique: prismaMocks.reportFindUnique,
      create: prismaMocks.reportCreate,
    },
    $transaction: prismaMocks.transaction,
  },
}));

function parseJson<T>(payload: string): T {
  return JSON.parse(payload) as T;
}

describe('contract: B1 wave2 social behaviors', () => {
  let app: FastifyInstance;
  let sequence = 0;

  const headers = {
    owner: { authorization: 'Bearer claw_test_owner' },
    commenter: { authorization: 'Bearer claw_test_commenter' },
    follower: { authorization: 'Bearer claw_test_follower' },
    outsider: { authorization: 'Bearer claw_test_outsider' },
    claimed1: { authorization: 'Bearer claw_test_claimed_1' },
    claimed2: { authorization: 'Bearer claw_test_claimed_2' },
    claimed3: { authorization: 'Bearer claw_test_claimed_3' },
    claimed4: { authorization: 'Bearer claw_test_claimed_4' },
    claimed5: { authorization: 'Bearer claw_test_claimed_5' },
  };

  type Agent = { id: string; name: string; avatarUrl: string };
  type Post = {
    id: string;
    agentId: string;
    caption: string | null;
    altText: string | null;
    deletedAt: Date | null;
    createdAt: Date;
    isSensitive: boolean;
    reportScore: number;
  };
  type Comment = {
    id: string;
    postId: string;
    agentId: string;
    content: string;
    parentId: string | null;
    depth: number;
    createdAt: Date;
    deletedAt: Date | null;
    isHiddenByPostOwner: boolean;
    hiddenByAgentId: string | null;
    hiddenAt: Date | null;
  };

  let agentsById = new Map<string, Agent>();
  let apiKeysByHash = new Map<string, { id: string; agentId: string; status: 'pending_claim' | 'claimed' }>();
  let uploadsOwned = new Map<string, string[]>();
  let postsById = new Map<string, Post>();
  let commentsById = new Map<string, Comment>();
  let likes = new Set<string>();
  let follows = new Set<string>();
  let reportsByPost = new Map<string, Set<string>>();

  const nextId = (prefix: string) => {
    sequence += 1;
    return `${prefix}_${sequence}`;
  };

  const followKey = (followerId: string, followingId: string) => `${followerId}:${followingId}`;
  const likeKey = (postId: string, agentId: string) => `${postId}:${agentId}`;

  beforeAll(async () => {
    const { buildServer } = await import('../../src/server');
    app = buildServer();
    await app.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sequence = 0;
    agentsById = new Map([
      ['agent_owner', { id: 'agent_owner', name: 'owner-agent', avatarUrl: 'https://cdn/avatar-owner.png' }],
      ['agent_commenter', { id: 'agent_commenter', name: 'commenter-agent', avatarUrl: 'https://cdn/avatar-commenter.png' }],
      ['agent_follower', { id: 'agent_follower', name: 'follower-agent', avatarUrl: 'https://cdn/avatar-follower.png' }],
      ['agent_outsider', { id: 'agent_outsider', name: 'outsider-agent', avatarUrl: 'https://cdn/avatar-outsider.png' }],
      ['agent_claimed_1', { id: 'agent_claimed_1', name: 'claimed-1', avatarUrl: 'https://cdn/avatar-c1.png' }],
      ['agent_claimed_2', { id: 'agent_claimed_2', name: 'claimed-2', avatarUrl: 'https://cdn/avatar-c2.png' }],
      ['agent_claimed_3', { id: 'agent_claimed_3', name: 'claimed-3', avatarUrl: 'https://cdn/avatar-c3.png' }],
      ['agent_claimed_4', { id: 'agent_claimed_4', name: 'claimed-4', avatarUrl: 'https://cdn/avatar-c4.png' }],
      ['agent_claimed_5', { id: 'agent_claimed_5', name: 'claimed-5', avatarUrl: 'https://cdn/avatar-c5.png' }],
    ]);

    const addKey = (raw: string, agentId: string, status: 'pending_claim' | 'claimed') => {
      apiKeysByHash.set(hashApiKey(raw), { id: `apikey_${agentId}`, agentId, status });
    };
    addKey('claw_test_owner', 'agent_owner', 'claimed');
    addKey('claw_test_commenter', 'agent_commenter', 'pending_claim');
    addKey('claw_test_follower', 'agent_follower', 'pending_claim');
    addKey('claw_test_outsider', 'agent_outsider', 'pending_claim');
    addKey('claw_test_claimed_1', 'agent_claimed_1', 'claimed');
    addKey('claw_test_claimed_2', 'agent_claimed_2', 'claimed');
    addKey('claw_test_claimed_3', 'agent_claimed_3', 'claimed');
    addKey('claw_test_claimed_4', 'agent_claimed_4', 'claimed');
    addKey('claw_test_claimed_5', 'agent_claimed_5', 'claimed');

    uploadsOwned = new Map([['agent_owner', ['media_owner_1']]]);
    postsById = new Map();
    commentsById = new Map();
    likes = new Set();
    follows = new Set();
    reportsByPost = new Map();

    prismaMocks.apiKeyFindUnique.mockImplementation(({ where }: { where: { keyHash?: string; id?: string } }) => {
      if (where.keyHash) {
        const record = apiKeysByHash.get(where.keyHash);
        if (!record) return null;
        return { id: record.id, agentId: record.agentId, keyHash: where.keyHash };
      }
      if (where.id) {
        const record = [...apiKeysByHash.values()].find((entry) => entry.id === where.id);
        return record ? { status: record.status } : null;
      }
      return null;
    });

    prismaMocks.agentFindUnique.mockImplementation(({ where }: { where: { id?: string; name?: string } }) => {
      if (where.id) {
        return agentsById.get(where.id) ?? null;
      }
      if (where.name) {
        const found = [...agentsById.values()].find((agent) => agent.name === where.name);
        return found ? { id: found.id } : null;
      }
      return null;
    });

    prismaMocks.uploadFindMany.mockImplementation(({ where }: { where: { agentId: string; mediaId: { in: string[] } } }) => {
      const owned = uploadsOwned.get(where.agentId) ?? [];
      return owned.filter((id) => where.mediaId.in.includes(id)).map((mediaId) => ({ mediaId }));
    });
    const formatPost = (post: Post) => ({
      id: post.id,
      images: [
        {
          media: {
            id: 'media_owner_1',
            url: 'https://cdn/media-owner.jpg',
            width: 100,
            height: 100,
            format: 'jpeg',
          },
        },
      ],
      caption: post.caption,
      altText: post.altText,
      hashtags: [],
      createdAt: post.createdAt,
      deletedAt: post.deletedAt,
      isSensitive: post.isSensitive,
      reportScore: post.reportScore,
      agent: { name: agentsById.get(post.agentId)?.name ?? 'unknown', avatarUrl: agentsById.get(post.agentId)?.avatarUrl },
      _count: {
        likes: [...likes].filter((value) => value.startsWith(`${post.id}:`)).length,
        comments: [...commentsById.values()].filter((comment) => comment.postId === post.id).length,
      },
    });

    prismaMocks.postCreate.mockImplementation(({ data }: { data: any }) => {
      const id = nextId('post');
      const created: Post = {
        id,
        agentId: data.agentId,
        caption: data.caption ?? null,
        altText: data.altText ?? null,
        deletedAt: null,
        createdAt: new Date(),
        isSensitive: data.isSensitive ?? false,
        reportScore: 0,
      };
      postsById.set(id, created);
      return formatPost(created);
    });

    prismaMocks.postFindUnique.mockImplementation(({ where, include, select }: { where: { id: string }; include?: any; select?: any }) => {
      const post = postsById.get(where.id);
      if (!post) return null;
      if (select) {
        return {
          ...(select.id ? { id: post.id } : {}),
          ...(select.agentId ? { agentId: post.agentId } : {}),
          ...(select.deletedAt ? { deletedAt: post.deletedAt } : {}),
          ...(select.isSensitive ? { isSensitive: post.isSensitive } : {}),
          ...(select.reportScore ? { reportScore: post.reportScore } : {}),
        };
      }
      if (include) {
        return formatPost(post);
      }
      return post;
    });

    prismaMocks.postUpdate.mockImplementation(({ where, data, select }: { where: { id: string }; data: any; select?: any }) => {
      const post = postsById.get(where.id);
      if (!post) throw new Error('missing post');
      const updated: Post = {
        ...post,
        deletedAt: data.deletedAt ?? post.deletedAt,
        isSensitive: data.isSensitive ?? post.isSensitive,
        reportScore: data.reportScore ?? post.reportScore,
      };
      postsById.set(where.id, updated);
      if (select) {
        return {
          ...(select.isSensitive ? { isSensitive: updated.isSensitive } : {}),
          ...(select.reportScore ? { reportScore: updated.reportScore } : {}),
        };
      }
      return updated;
    });

    prismaMocks.likeFindUnique.mockImplementation(({ where }: { where: { postId_agentId: { postId: string; agentId: string } } }) =>
      likes.has(likeKey(where.postId_agentId.postId, where.postId_agentId.agentId)) ? { id: 'like_exists' } : null,
    );
    prismaMocks.likeCreate.mockImplementation(({ data }: { data: { postId: string; agentId: string } }) => {
      likes.add(likeKey(data.postId, data.agentId));
      return { id: nextId('like') };
    });
    prismaMocks.likeDeleteMany.mockImplementation(({ where }: { where: { postId: string; agentId: string } }) => {
      likes.delete(likeKey(where.postId, where.agentId));
      return { count: 1 };
    });

    prismaMocks.followFindUnique.mockImplementation(({ where }: { where: { followerId_followingId: { followerId: string; followingId: string } } }) =>
      follows.has(followKey(where.followerId_followingId.followerId, where.followerId_followingId.followingId))
        ? { id: 'follow_exists' }
        : null,
    );
    prismaMocks.followCreate.mockImplementation(({ data }: { data: { followerId: string; followingId: string } }) => {
      follows.add(followKey(data.followerId, data.followingId));
      return { id: nextId('follow') };
    });
    prismaMocks.followDeleteMany.mockImplementation(({ where }: { where: { followerId: string; followingId: string } }) => {
      follows.delete(followKey(where.followerId, where.followingId));
      return { count: 1 };
    });

    prismaMocks.commentCreate.mockImplementation(({ data }: { data: any }) => {
      const created: Comment = {
        id: nextId('comment'),
        postId: data.postId,
        agentId: data.agentId,
        content: data.content,
        parentId: data.parentId ?? null,
        depth: data.depth,
        createdAt: new Date(),
        deletedAt: null,
        isHiddenByPostOwner: false,
        hiddenByAgentId: null,
        hiddenAt: null,
      };
      commentsById.set(created.id, created);
      const author = agentsById.get(created.agentId);
      return { ...created, agent: { name: author?.name ?? 'unknown', avatarUrl: author?.avatarUrl } };
    });

    prismaMocks.commentFindUnique.mockImplementation(({ where, select }: { where: { id: string }; select?: any }) => {
      const comment = commentsById.get(where.id);
      if (!comment) return null;
      const post = postsById.get(comment.postId);
      if (!select) return comment;
      return {
        ...(select.id ? { id: comment.id } : {}),
        ...(select.postId ? { postId: comment.postId } : {}),
        ...(select.depth ? { depth: comment.depth } : {}),
        ...(select.agentId ? { agentId: comment.agentId } : {}),
        ...(select.deletedAt ? { deletedAt: comment.deletedAt } : {}),
        ...(select.isHiddenByPostOwner ? { isHiddenByPostOwner: comment.isHiddenByPostOwner } : {}),
        ...(select.post ? { post: { agentId: post?.agentId, deletedAt: post?.deletedAt ?? null } } : {}),
      };
    });

    prismaMocks.commentFindMany.mockImplementation(({ where, orderBy, take }: { where: any; orderBy: Array<any>; take: number }) => {
      const ordered = [...commentsById.values()]
        .filter((comment) => {
          if (where.postId !== undefined && comment.postId !== where.postId) return false;
          if (where.parentId === null && comment.parentId !== null) return false;
          if (typeof where.parentId === 'string' && comment.parentId !== where.parentId) return false;
          return true;
        })
        .sort((left, right) => {
          const direction = orderBy[0].createdAt;
          if (left.createdAt.getTime() === right.createdAt.getTime()) {
            return direction === 'desc' ? (left.id < right.id ? 1 : -1) : left.id < right.id ? -1 : 1;
          }
          return direction === 'desc'
            ? right.createdAt.getTime() - left.createdAt.getTime()
            : left.createdAt.getTime() - right.createdAt.getTime();
        })
        .slice(0, take);

      return ordered.map((comment) => {
        const author = agentsById.get(comment.agentId);
        return { ...comment, agent: { name: author?.name ?? 'unknown', avatarUrl: author?.avatarUrl } };
      });
    });

    prismaMocks.commentGroupBy.mockImplementation(({ where }: { where: { parentId: { in: string[] } } }) => {
      return where.parentId.in.map((parentId) => ({
        parentId,
        _count: {
          _all: [...commentsById.values()].filter((comment) => comment.parentId === parentId).length,
        },
      }));
    });

    prismaMocks.commentUpdate.mockImplementation(({ where, data }: { where: { id: string }; data: any }) => {
      const comment = commentsById.get(where.id);
      if (!comment) throw new Error('missing comment');
      commentsById.set(where.id, {
        ...comment,
        deletedAt: data.deletedAt ?? comment.deletedAt,
        isHiddenByPostOwner: data.isHiddenByPostOwner ?? comment.isHiddenByPostOwner,
        hiddenByAgentId: data.hiddenByAgentId ?? comment.hiddenByAgentId,
        hiddenAt: data.hiddenAt ?? comment.hiddenAt,
      });
      return commentsById.get(where.id);
    });

    prismaMocks.reportFindUnique.mockImplementation(({ where }: { where: { postId_reporterAgentId: { postId: string; reporterAgentId: string } } }) => {
      const seen = reportsByPost.get(where.postId_reporterAgentId.postId);
      if (!seen?.has(where.postId_reporterAgentId.reporterAgentId)) return null;
      return {
        id: 'report_existing',
        postId: where.postId_reporterAgentId.postId,
        reporterAgentId: where.postId_reporterAgentId.reporterAgentId,
        reason: 'spam',
        details: 'duplicate',
        weight: 1,
        createdAt: new Date('2026-02-09T00:00:00.000Z'),
      };
    });

    prismaMocks.reportCreate.mockImplementation(({ data }: { data: any }) => {
      const seen = reportsByPost.get(data.postId) ?? new Set<string>();
      seen.add(data.reporterAgentId);
      reportsByPost.set(data.postId, seen);
      return {
        id: nextId('report'),
        postId: data.postId,
        reporterAgentId: data.reporterAgentId,
        reason: data.reason,
        details: data.details,
        weight: data.weight,
        createdAt: new Date(),
      };
    });

    prismaMocks.transaction.mockImplementation(async (operations: unknown[]) => Promise.all(operations));
  });

  afterAll(async () => {
    await app.close();
  });

  it('implements wave2 social contract parity flows', async () => {
    const postCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: headers.owner,
      payload: { images: [{ media_id: 'media_owner_1' }], caption: ' hello ' },
    });
    expect(postCreate.statusCode).toBe(201);
    const postId = parseJson<{ success: true; data: { id: string } }>(postCreate.payload).data.id;

    expect((await app.inject({ method: 'GET', url: `/api/v1/posts/${postId}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/v1/posts/${postId}/like`, headers: headers.commenter })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/v1/posts/${postId}/like`, headers: headers.commenter })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/posts/${postId}/like`, headers: headers.commenter })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/posts/${postId}/like`, headers: headers.commenter })).statusCode).toBe(200);

    expect((await app.inject({ method: 'POST', url: '/api/v1/agents/owner-agent/follow', headers: headers.follower })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/agents/owner-agent/follow', headers: headers.follower })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/agents/owner-agent/follow', headers: headers.follower })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/agents/owner-agent/follow', headers: headers.follower })).statusCode).toBe(200);

    const firstComment = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/comments`,
      headers: headers.commenter,
      payload: { content: ' top-level ' },
    });
    expect(firstComment.statusCode).toBe(201);
    const firstCommentId = parseJson<{ success: true; data: { id: string } }>(firstComment.payload).data.id;

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/posts/${postId}/comments`,
          headers: headers.owner,
          payload: { content: 'reply', parent_id: firstCommentId },
        })
      ).statusCode,
    ).toBe(201);

    const commentList = await app.inject({ method: 'GET', url: `/api/v1/posts/${postId}/comments` });
    expect(commentList.statusCode).toBe(200);
    expect(parseJson<{ success: true; data: { items: Array<{ replies_count: number }> } }>(commentList.payload).data.items[0].replies_count).toBe(1);

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/comments/${firstCommentId}`, headers: headers.commenter })).statusCode).toBe(200);
    const deletedList = await app.inject({ method: 'GET', url: `/api/v1/posts/${postId}/comments` });
    expect(parseJson<{ success: true; data: { items: Array<{ content: string; is_deleted: boolean }> } }>(deletedList.payload).data.items[0]).toEqual(
      expect.objectContaining({ content: '[deleted]', is_deleted: true }),
    );

    const hiddenComment = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/comments`,
      headers: headers.commenter,
      payload: { content: 'hide target' },
    });
    const hiddenCommentId = parseJson<{ success: true; data: { id: string } }>(hiddenComment.payload).data.id;
    expect((await app.inject({ method: 'POST', url: `/api/v1/comments/${hiddenCommentId}/hide`, headers: headers.outsider })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1/comments/${hiddenCommentId}/hide`, headers: headers.owner })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/v1/comments/${hiddenCommentId}/hide`, headers: headers.owner })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/comments/${hiddenCommentId}/hide`, headers: headers.owner })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/comments/${hiddenCommentId}/hide`, headers: headers.owner })).statusCode).toBe(200);

    const selfReport = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/report`,
      headers: headers.owner,
      payload: { reason: 'spam' },
    });
    expect(selfReport.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(selfReport.payload).code).toBe('cannot_report_own_post');

    const report1 = await app.inject({ method: 'POST', url: `/api/v1/posts/${postId}/report`, headers: headers.claimed1, payload: { reason: 'spam' } });
    expect(report1.statusCode).toBe(201);
    expect(parseJson<{ success: true; data: { post_report_score: number } }>(report1.payload).data.post_report_score).toBe(1);
    expect((await app.inject({ method: 'POST', url: `/api/v1/posts/${postId}/report`, headers: headers.claimed1, payload: { reason: 'harassment' } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/api/v1/posts/${postId}/report`, headers: headers.claimed2, payload: { reason: 'spam' } });
    await app.inject({ method: 'POST', url: `/api/v1/posts/${postId}/report`, headers: headers.claimed3, payload: { reason: 'spam' } });
    await app.inject({ method: 'POST', url: `/api/v1/posts/${postId}/report`, headers: headers.claimed4, payload: { reason: 'spam' } });
    const threshold = await app.inject({ method: 'POST', url: `/api/v1/posts/${postId}/report`, headers: headers.claimed5, payload: { reason: 'spam' } });
    expect(threshold.statusCode).toBe(201);
    expect(parseJson<{ success: true; data: { post_report_score: number; post_is_sensitive: boolean } }>(threshold.payload).data).toEqual(
      expect.objectContaining({ post_report_score: 5, post_is_sensitive: true }),
    );

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/posts/${postId}`, headers: headers.owner })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/posts/${postId}` })).statusCode).toBe(404);
  });

  it('enforces max comment depth of 6', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/v1/posts', headers: headers.owner, payload: { images: [{ media_id: 'media_owner_1' }] } });
    const postId = parseJson<{ success: true; data: { id: string } }>(post.payload).data.id;

    let parentId: string | undefined;
    for (let depth = 1; depth <= 6; depth += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/posts/${postId}/comments`,
        headers: headers.commenter,
        payload: { content: `depth-${depth}`, ...(parentId ? { parent_id: parentId } : {}) },
      });
      expect(response.statusCode).toBe(201);
      parentId = parseJson<{ success: true; data: { id: string } }>(response.payload).data.id;
    }

    const tooDeep = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/comments`,
      headers: headers.commenter,
      payload: { content: 'too deep', parent_id: parentId },
    });

    expect(tooDeep.statusCode).toBe(400);
    expect(parseJson<{ code: string }>(tooDeep.payload).code).toBe('validation_error');
  });
});
