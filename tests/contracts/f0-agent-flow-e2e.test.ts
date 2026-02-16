/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const transportState = vi.hoisted(() => ({
  deliveries: [] as Array<{
    ownerId: string;
    email: string;
    token: string;
    requestId: string;
    requestedByAgentId?: string;
  }>,
}));

const prismaMocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  agentFindUnique: vi.fn(),
  agentUpdate: vi.fn(),
  apiKeyFindUnique: vi.fn(),
  apiKeyUpdateMany: vi.fn(),
  ownerUpsert: vi.fn(),
  ownerEmailTokenCreate: vi.fn(),
  ownerEmailTokenFindUnique: vi.fn(),
  ownerEmailTokenUpdateMany: vi.fn(),
  ownerSessionCreate: vi.fn(),
  agentOwnershipFindUnique: vi.fn(),
  agentOwnershipCreate: vi.fn(),
  uploadCreate: vi.fn(),
  uploadFindUnique: vi.fn(),
  uploadUpdate: vi.fn(),
  uploadFindFirst: vi.fn(),
  uploadFindMany: vi.fn(),
  mediaCreate: vi.fn(),
  mediaFindUnique: vi.fn(),
  postCreate: vi.fn(),
  postFindUnique: vi.fn(),
  postUpdate: vi.fn(),
  followFindUnique: vi.fn(),
  followCreate: vi.fn(),
  followDeleteMany: vi.fn(),
  likeFindUnique: vi.fn(),
  likeCreate: vi.fn(),
  likeDeleteMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../src/owner/email-transport', () => ({
  deliverOwnerEmailToken: vi.fn(async (_request, payload) => {
    transportState.deliveries.push(payload);
  }),
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
    owner: {
      upsert: prismaMocks.ownerUpsert,
    },
    ownerEmailToken: {
      create: prismaMocks.ownerEmailTokenCreate,
      findUnique: prismaMocks.ownerEmailTokenFindUnique,
      updateMany: prismaMocks.ownerEmailTokenUpdateMany,
    },
    ownerSession: {
      create: prismaMocks.ownerSessionCreate,
    },
    agentOwnership: {
      findUnique: prismaMocks.agentOwnershipFindUnique,
      create: prismaMocks.agentOwnershipCreate,
    },
    upload: {
      create: prismaMocks.uploadCreate,
      findUnique: prismaMocks.uploadFindUnique,
      update: prismaMocks.uploadUpdate,
      findFirst: prismaMocks.uploadFindFirst,
      findMany: prismaMocks.uploadFindMany,
    },
    media: {
      create: prismaMocks.mediaCreate,
      findUnique: prismaMocks.mediaFindUnique,
    },
    post: {
      create: prismaMocks.postCreate,
      findUnique: prismaMocks.postFindUnique,
      update: prismaMocks.postUpdate,
    },
    follow: {
      findUnique: prismaMocks.followFindUnique,
      create: prismaMocks.followCreate,
      deleteMany: prismaMocks.followDeleteMany,
    },
    like: {
      findUnique: prismaMocks.likeFindUnique,
      create: prismaMocks.likeCreate,
      deleteMany: prismaMocks.likeDeleteMany,
    },
    $transaction: prismaMocks.transaction,
  },
}));

type ClaimStatus = 'pending_claim' | 'claimed';

type AgentRecord = {
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

type ApiKeyRecord = {
  id: string;
  agentId: string;
  keyHash: string;
  status: ClaimStatus;
  claimToken: string;
  verificationCode: string;
  createdAt: Date;
};

type OwnerRecord = {
  id: string;
  email: string;
  createdAt: Date;
};

type OwnerEmailTokenRecord = {
  id: string;
  ownerId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  requestedByAgentId: string | null;
};

type UploadRecord = {
  id: string;
  agentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  checksum: string | null;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  storageKey: string;
  expiresAt: Date;
  mediaId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type MediaRecord = {
  id: string;
  storageKey: string;
  url: string;
  width: number;
  height: number;
  format: string;
};

type PostRecord = {
  id: string;
  agentId: string;
  caption: string | null;
  altText: string | null;
  isSensitive: boolean;
  isOwnerInfluenced: boolean;
  reportScore: number;
  createdAt: Date;
  deletedAt: Date | null;
  mediaIds: string[];
  hashtags: string[];
};

function parseJson<T>(payload: string): T {
  return JSON.parse(payload) as T;
}

function selectProjection(
  row: Record<string, unknown>,
  select?: Record<string, boolean>,
): Record<string, unknown> {
  if (!select) {
    return { ...row };
  }

  return Object.entries(select).reduce<Record<string, unknown>>((projection, [key, enabled]) => {
    if (enabled) {
      projection[key] = row[key];
    }
    return projection;
  }, {});
}

function signatureBytesForContentType(contentType: string): number[] {
  if (contentType === 'image/png') {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  }
  if (contentType === 'image/jpeg') {
    return [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
  }
  return [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];
}

describe('contract: F0 agent lifecycle e2e', () => {
  let app: FastifyInstance;
  let sequence = 0;

  const agentsById = new Map<string, AgentRecord>();
  const apiKeysByHash = new Map<string, ApiKeyRecord>();
  const apiKeysById = new Map<string, ApiKeyRecord>();
  const ownersByEmail = new Map<string, OwnerRecord>();
  const ownersById = new Map<string, OwnerRecord>();
  const ownerEmailTokensByHash = new Map<string, OwnerEmailTokenRecord>();
  const ownershipByAgentId = new Map<string, { ownerId: string; agentId: string; createdAt: Date }>();
  const uploadsById = new Map<string, UploadRecord>();
  const mediaById = new Map<string, MediaRecord>();
  const postsById = new Map<string, PostRecord>();
  const follows = new Set<string>();
  const likes = new Set<string>();
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn<typeof fetch>();

  const nextId = (prefix: string) => {
    sequence += 1;
    return `${prefix}_${sequence}`;
  };

  const followKey = (followerId: string, followingId: string) => `${followerId}:${followingId}`;
  const likeKey = (postId: string, agentId: string) => `${postId}:${agentId}`;

  const putApiKey = (record: ApiKeyRecord) => {
    apiKeysByHash.set(record.keyHash, record);
    apiKeysById.set(record.id, record);
  };

  const applyAgentUpdate = (where: { id: string }, data: any) => {
    const existing = agentsById.get(where.id);
    if (!existing) {
      throw new Error('missing agent');
    }

    const updated: AgentRecord = {
      ...existing,
      bio: data.bio !== undefined ? data.bio : existing.bio,
      avatarUrl: data.avatarUrl !== undefined ? data.avatarUrl : existing.avatarUrl,
      metadata: data.metadata !== undefined ? data.metadata : existing.metadata,
      followerCount:
        existing.followerCount +
        (data.followerCount?.increment ?? 0) -
        (data.followerCount?.decrement ?? 0),
      followingCount:
        existing.followingCount +
        (data.followingCount?.increment ?? 0) -
        (data.followingCount?.decrement ?? 0),
    };
    agentsById.set(updated.id, updated);
    return updated;
  };

  const buildPostIncludePayload = (post: PostRecord) => {
    const author = agentsById.get(post.agentId);
    if (!author) {
      throw new Error('missing post author');
    }

    return {
      id: post.id,
      caption: post.caption,
      altText: post.altText,
      createdAt: post.createdAt,
      deletedAt: post.deletedAt,
      isSensitive: post.isSensitive,
      isOwnerInfluenced: post.isOwnerInfluenced,
      reportScore: post.reportScore,
      agent: {
        name: author.name,
        avatarUrl: author.avatarUrl,
      },
      images: post.mediaIds.map((mediaId, position) => {
        const media = mediaById.get(mediaId);
        if (!media) {
          throw new Error('missing post media');
        }
        return {
          position,
          media: {
            id: media.id,
            url: media.url,
            width: media.width,
            height: media.height,
            format: media.format,
          },
        };
      }),
      hashtags: post.hashtags.map((tag) => ({
        hashtag: {
          tag,
        },
      })),
      _count: {
        likes: [...likes].filter((value) => value.startsWith(`${post.id}:`)).length,
        comments: 0,
      },
    };
  };

  beforeAll(async () => {
    const { buildServer } = await import('../../src/server');
    app = buildServer();
    await app.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sequence = 0;
    transportState.deliveries.length = 0;
    agentsById.clear();
    apiKeysByHash.clear();
    apiKeysById.clear();
    ownersByEmail.clear();
    ownersById.clear();
    ownerEmailTokensByHash.clear();
    ownershipByAgentId.clear();
    uploadsById.clear();
    mediaById.clear();
    postsById.clear();
    follows.clear();
    likes.clear();
    fetchMock.mockReset();

    fetchMock.mockImplementation(async (input) => {
      const url = input instanceof URL ? input.toString() : input.toString();
      const upload = [...uploadsById.values()].find(
        (record) => record.storageKey.length > 0 && url.includes(record.storageKey),
      );
      if (!upload) {
        return new Response(new Uint8Array(), { status: 404 });
      }
      return new Response(Uint8Array.from(signatureBytesForContentType(upload.contentType)), {
        status: 206,
      });
    });
    globalThis.fetch = fetchMock;

    prismaMocks.agentCreate.mockImplementation(({ data, select }: any) => {
      const now = new Date();
      const agent: AgentRecord = {
        id: nextId('agent'),
        name: data.name,
        bio: data.bio ?? null,
        avatarUrl: null,
        followerCount: 0,
        followingCount: 0,
        createdAt: now,
        lastActive: null,
        metadata: null,
      };
      agentsById.set(agent.id, agent);

      const apiKeyRecord: ApiKeyRecord = {
        id: nextId('apikey'),
        agentId: agent.id,
        keyHash: data.apiKey.create.keyHash,
        claimToken: data.apiKey.create.claimToken,
        verificationCode: data.apiKey.create.verificationCode,
        status: 'pending_claim',
        createdAt: now,
      };
      putApiKey(apiKeyRecord);

      return selectProjection(agent as unknown as Record<string, unknown>, select);
    });

    prismaMocks.agentFindUnique.mockImplementation(({ where, select }: any) => {
      let agent: AgentRecord | undefined;
      if (where.id) {
        agent = agentsById.get(where.id);
      } else if (where.name) {
        agent = [...agentsById.values()].find((candidate) => candidate.name === where.name);
      }
      if (!agent) {
        return null;
      }
      return selectProjection(agent as unknown as Record<string, unknown>, select);
    });

    prismaMocks.agentUpdate.mockImplementation(({ where, data, select }: any) => {
      const updated = applyAgentUpdate(where, data);
      return selectProjection(updated as unknown as Record<string, unknown>, select);
    });

    prismaMocks.apiKeyFindUnique.mockImplementation(({ where, select }: any) => {
      let record: ApiKeyRecord | undefined;
      if (where.keyHash) {
        record = apiKeysByHash.get(where.keyHash);
      } else if (where.id) {
        record = apiKeysById.get(where.id);
      }
      if (!record) {
        return null;
      }
      return selectProjection(record as unknown as Record<string, unknown>, select);
    });

    prismaMocks.apiKeyUpdateMany.mockImplementation(({ where, data }: any) => {
      let count = 0;
      for (const existing of [...apiKeysById.values()]) {
        if (where.agentId && existing.agentId !== where.agentId) {
          continue;
        }
        if (where.status && existing.status !== where.status) {
          continue;
        }

        const next: ApiKeyRecord = {
          ...existing,
          status: data.status ?? existing.status,
          keyHash: data.keyHash ?? existing.keyHash,
        };
        apiKeysByHash.delete(existing.keyHash);
        putApiKey(next);
        count += 1;
      }
      return { count };
    });

    prismaMocks.ownerUpsert.mockImplementation(({ where, create }: any) => {
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
    });

    prismaMocks.ownerEmailTokenCreate.mockImplementation(({ data }: any) => {
      const tokenRecord: OwnerEmailTokenRecord = {
        id: nextId('owner_token'),
        ownerId: data.ownerId,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
        consumedAt: null,
        requestedByAgentId: data.requestedByAgentId ?? null,
      };
      ownerEmailTokensByHash.set(tokenRecord.tokenHash, tokenRecord);
      return tokenRecord;
    });

    prismaMocks.ownerEmailTokenFindUnique.mockImplementation(({ where }: any) => {
      const token = ownerEmailTokensByHash.get(where.tokenHash);
      if (!token) {
        return null;
      }
      const owner = ownersById.get(token.ownerId);
      if (!owner) {
        return null;
      }
      return {
        id: token.id,
        ownerId: token.ownerId,
        expiresAt: token.expiresAt,
        consumedAt: token.consumedAt,
        requestedByAgentId: token.requestedByAgentId,
        owner: {
          id: owner.id,
          email: owner.email,
          createdAt: owner.createdAt,
        },
      };
    });

    prismaMocks.ownerEmailTokenUpdateMany.mockImplementation(({ where, data }: any) => {
      const token = [...ownerEmailTokensByHash.values()].find((candidate) => candidate.id === where.id);
      if (!token || token.consumedAt !== where.consumedAt) {
        return { count: 0 };
      }
      token.consumedAt = data.consumedAt ?? new Date();
      ownerEmailTokensByHash.set(token.tokenHash, token);
      return { count: 1 };
    });

    prismaMocks.ownerSessionCreate.mockImplementation(({ data }: any) => ({
      id: nextId('owner_session'),
      ownerId: data.ownerId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
      revokedAt: null,
      createdAt: new Date(),
    }));

    prismaMocks.agentOwnershipFindUnique.mockImplementation(({ where, select }: any) => {
      const ownership = ownershipByAgentId.get(where.agentId);
      if (!ownership) {
        return null;
      }
      return selectProjection(ownership as unknown as Record<string, unknown>, select);
    });

    prismaMocks.agentOwnershipCreate.mockImplementation(({ data }: any) => {
      const ownership = {
        id: nextId('ownership'),
        ownerId: data.ownerId,
        agentId: data.agentId,
        createdAt: new Date(),
      };
      ownershipByAgentId.set(data.agentId, ownership);
      return ownership;
    });

    prismaMocks.uploadCreate.mockImplementation(({ data, select }: any) => {
      const now = new Date();
      const upload: UploadRecord = {
        id: data.id,
        agentId: data.agentId,
        filename: data.filename,
        contentType: data.contentType,
        sizeBytes: data.sizeBytes,
        checksum: data.checksum ?? null,
        status: data.status ?? 'pending',
        storageKey: data.storageKey,
        expiresAt: data.expiresAt,
        mediaId: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      uploadsById.set(upload.id, upload);
      return selectProjection(upload as unknown as Record<string, unknown>, select);
    });

    prismaMocks.uploadFindUnique.mockImplementation(({ where, select }: any) => {
      const upload = uploadsById.get(where.id);
      if (!upload) {
        return null;
      }
      return selectProjection(upload as unknown as Record<string, unknown>, select);
    });

    prismaMocks.uploadUpdate.mockImplementation(({ where, data }: any) => {
      const existing = uploadsById.get(where.id);
      if (!existing) {
        throw new Error('missing upload');
      }
      const updated: UploadRecord = {
        ...existing,
        status: data.status ?? existing.status,
        mediaId: data.mediaId ?? existing.mediaId,
        completedAt: data.completedAt ?? existing.completedAt,
        updatedAt: new Date(),
      };
      uploadsById.set(where.id, updated);
      return updated;
    });

    prismaMocks.uploadFindFirst.mockImplementation(({ where, select }: any) => {
      const record = [...uploadsById.values()].find(
        (upload) =>
          upload.agentId === where.agentId &&
          upload.mediaId === where.mediaId &&
          upload.status === where.status,
      );
      if (!record) {
        return null;
      }
      return selectProjection(record as unknown as Record<string, unknown>, select);
    });

    prismaMocks.uploadFindMany.mockImplementation(({ where, select }: any) => {
      const mediaIds = where.mediaId?.in ?? [];
      const rows = [...uploadsById.values()].filter(
        (upload) =>
          upload.agentId === where.agentId &&
          upload.status === where.status &&
          upload.mediaId !== null &&
          mediaIds.includes(upload.mediaId),
      );

      return rows.map((row) => selectProjection(row as unknown as Record<string, unknown>, select));
    });

    prismaMocks.mediaCreate.mockImplementation(({ data, select }: any) => {
      const created: MediaRecord = {
        id: data.id,
        storageKey: data.storageKey,
        url: data.url,
        width: data.width,
        height: data.height,
        format: data.format,
      };
      mediaById.set(created.id, created);
      return selectProjection(created as unknown as Record<string, unknown>, select);
    });

    prismaMocks.mediaFindUnique.mockImplementation(({ where, select }: any) => {
      const media = mediaById.get(where.id);
      if (!media) {
        return null;
      }
      return selectProjection(media as unknown as Record<string, unknown>, select);
    });

    prismaMocks.postCreate.mockImplementation(({ data }: any) => {
      const post: PostRecord = {
        id: nextId('post'),
        agentId: data.agentId,
        caption: data.caption ?? null,
        altText: data.altText ?? null,
        isSensitive: data.isSensitive ?? false,
        isOwnerInfluenced: data.isOwnerInfluenced ?? false,
        reportScore: 0,
        createdAt: new Date(),
        deletedAt: null,
        mediaIds: data.images.create
          .slice()
          .sort((left: { position: number }, right: { position: number }) => left.position - right.position)
          .map((image: { mediaId: string }) => image.mediaId),
        hashtags: data.hashtags
          ? data.hashtags.create.map(
              (row: { hashtag: { connectOrCreate: { where: { tag: string } } } }) =>
                row.hashtag.connectOrCreate.where.tag,
            )
          : [],
      };
      postsById.set(post.id, post);
      return buildPostIncludePayload(post);
    });

    prismaMocks.postFindUnique.mockImplementation(({ where, select, include }: any) => {
      const post = postsById.get(where.id);
      if (!post) {
        return null;
      }

      if (include) {
        return buildPostIncludePayload(post);
      }

      if (select) {
        return selectProjection(post as unknown as Record<string, unknown>, select);
      }

      return post;
    });

    prismaMocks.postUpdate.mockImplementation(({ where, data, select }: any) => {
      const existing = postsById.get(where.id);
      if (!existing) {
        throw new Error('missing post');
      }
      const updated: PostRecord = {
        ...existing,
        deletedAt: data.deletedAt ?? existing.deletedAt,
        isSensitive: data.isSensitive ?? existing.isSensitive,
        reportScore: data.reportScore ?? existing.reportScore,
      };
      postsById.set(updated.id, updated);
      return select ? selectProjection(updated as unknown as Record<string, unknown>, select) : updated;
    });

    prismaMocks.followFindUnique.mockImplementation(({ where }: any) => {
      const key = followKey(where.followerId_followingId.followerId, where.followerId_followingId.followingId);
      return follows.has(key) ? { id: 'follow_existing' } : null;
    });

    prismaMocks.followCreate.mockImplementation(({ data }: any) => {
      follows.add(followKey(data.followerId, data.followingId));
      return { id: nextId('follow') };
    });

    prismaMocks.followDeleteMany.mockImplementation(({ where }: any) => {
      const key = followKey(where.followerId, where.followingId);
      const existed = follows.has(key);
      follows.delete(key);
      return { count: existed ? 1 : 0 };
    });

    prismaMocks.likeFindUnique.mockImplementation(({ where }: any) => {
      const key = likeKey(where.postId_agentId.postId, where.postId_agentId.agentId);
      return likes.has(key) ? { id: 'like_existing' } : null;
    });

    prismaMocks.likeCreate.mockImplementation(({ data }: any) => {
      likes.add(likeKey(data.postId, data.agentId));
      return { id: nextId('like') };
    });

    prismaMocks.likeDeleteMany.mockImplementation(({ where }: any) => {
      const key = likeKey(where.postId, where.agentId);
      const existed = likes.has(key);
      likes.delete(key);
      return { count: existed ? 1 : 0 };
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

      return argument;
    });
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
  });

  async function uploadAndSetAvatar(apiKey: string, label: string) {
    const authHeader = { authorization: `Bearer ${apiKey}` };

    const uploadStart = await app.inject({
      method: 'POST',
      url: '/api/v1/media/uploads',
      headers: authHeader,
      payload: {
        filename: `${label}.png`,
        content_type: 'image/png',
        size_bytes: 1024,
      },
    });
    expect(uploadStart.statusCode).toBe(201);
    const uploadStartBody = parseJson<{ success: true; data: { upload_id: string } }>(uploadStart.payload);

    const uploadComplete = await app.inject({
      method: 'POST',
      url: `/api/v1/media/uploads/${uploadStartBody.data.upload_id}/complete`,
      headers: authHeader,
    });
    expect(uploadComplete.statusCode).toBe(201);
    const uploadCompleteBody = parseJson<{ success: true; data: { media_id: string; status: string } }>(
      uploadComplete.payload,
    );

    const setAvatar = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/me/avatar',
      headers: authHeader,
      payload: {
        media_id: uploadCompleteBody.data.media_id,
      },
    });
    expect(setAvatar.statusCode).toBe(200);
    const setAvatarBody = parseJson<{ success: true; data: { avatar_url?: string } }>(setAvatar.payload);
    const mediaUrl = mediaById.get(uploadCompleteBody.data.media_id)?.url;
    expect(setAvatarBody.data.avatar_url).toBe(mediaUrl);

    return {
      mediaId: uploadCompleteBody.data.media_id,
      avatarUrl: mediaUrl ?? '',
    };
  }

  it('runs register -> claim -> avatar upload -> post -> follow/like -> profile readback', async () => {
    const alphaName = 'alpha-flow';
    const betaName = 'beta-flow';

    const registerAlpha = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/register',
      payload: {
        name: alphaName,
        description: 'alpha lifecycle agent',
      },
    });
    expect(registerAlpha.statusCode).toBe(201);
    const alphaKey = parseJson<{ success: true; data: { agent: { api_key: string } } }>(
      registerAlpha.payload,
    ).data.agent.api_key;

    const registerBeta = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/register',
      payload: {
        name: betaName,
        description: 'beta lifecycle agent',
      },
    });
    expect(registerBeta.statusCode).toBe(201);
    const betaKey = parseJson<{ success: true; data: { agent: { api_key: string } } }>(
      registerBeta.payload,
    ).data.agent.api_key;

    const alphaHeaders = { authorization: `Bearer ${alphaKey}` };
    const betaHeaders = { authorization: `Bearer ${betaKey}` };

    const alphaStatusBeforeClaim = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/status',
      headers: alphaHeaders,
    });
    expect(alphaStatusBeforeClaim.statusCode).toBe(200);
    expect(
      parseJson<{ success: true; data: { status: ClaimStatus } }>(alphaStatusBeforeClaim.payload).data.status,
    ).toBe('pending_claim');

    const setupOwnerEmail = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/me/setup-owner-email',
      headers: alphaHeaders,
      payload: {
        email: 'owner-flow@clawgram.test',
      },
    });
    expect(setupOwnerEmail.statusCode).toBe(200);

    const deliveredToken = transportState.deliveries[transportState.deliveries.length - 1];
    expect(deliveredToken?.token).toBeTruthy();
    expect(deliveredToken?.requestedByAgentId).toBeTruthy();

    const ownerEmailComplete = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/email/complete',
      payload: {
        token: deliveredToken.token,
      },
    });
    expect(ownerEmailComplete.statusCode).toBe(200);

    const alphaStatusAfterClaim = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/status',
      headers: alphaHeaders,
    });
    expect(alphaStatusAfterClaim.statusCode).toBe(200);
    expect(
      parseJson<{ success: true; data: { status: ClaimStatus } }>(alphaStatusAfterClaim.payload).data.status,
    ).toBe('claimed');

    const alphaAvatar = await uploadAndSetAvatar(alphaKey, 'alpha-avatar');
    const betaAvatar = await uploadAndSetAvatar(betaKey, 'beta-avatar');
    expect(betaAvatar.avatarUrl).toContain('/media/');

    const createPost = await app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: alphaHeaders,
      payload: {
        images: [{ media_id: alphaAvatar.mediaId }],
        caption: 'Alpha launch post',
      },
    });
    expect(createPost.statusCode).toBe(201);
    const postId = parseJson<{ success: true; data: { id: string } }>(createPost.payload).data.id;

    const followAlpha = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${alphaName}/follow`,
      headers: betaHeaders,
    });
    expect(followAlpha.statusCode).toBe(200);
    const followAlphaRetry = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${alphaName}/follow`,
      headers: betaHeaders,
    });
    expect(followAlphaRetry.statusCode).toBe(200);

    const likePost = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/like`,
      headers: betaHeaders,
    });
    expect(likePost.statusCode).toBe(200);
    const likePostRetry = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/like`,
      headers: betaHeaders,
    });
    expect(likePostRetry.statusCode).toBe(200);

    const alphaProfile = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${alphaName}`,
    });
    expect(alphaProfile.statusCode).toBe(200);
    const alphaProfileBody = parseJson<{
      success: true;
      data: { name: string; follower_count: number; following_count: number; avatar_url?: string };
    }>(alphaProfile.payload);
    expect(alphaProfileBody.data.name).toBe(alphaName);
    expect(alphaProfileBody.data.follower_count).toBe(1);
    expect(alphaProfileBody.data.following_count).toBe(0);
    expect(alphaProfileBody.data.avatar_url).toBe(alphaAvatar.avatarUrl);

    const betaMe = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/me',
      headers: betaHeaders,
    });
    expect(betaMe.statusCode).toBe(200);
    const betaMeBody = parseJson<{ success: true; data: { following_count: number; avatar_url?: string } }>(
      betaMe.payload,
    );
    expect(betaMeBody.data.following_count).toBe(1);
    expect(betaMeBody.data.avatar_url).toBeTruthy();

    const readPost = await app.inject({
      method: 'GET',
      url: `/api/v1/posts/${postId}`,
    });
    expect(readPost.statusCode).toBe(200);
    const readPostBody = parseJson<{
      success: true;
      data: { id: string; like_count: number; author: { name: string; avatar_url?: string } };
    }>(readPost.payload);
    expect(readPostBody.data.id).toBe(postId);
    expect(readPostBody.data.like_count).toBe(1);
    expect(readPostBody.data.author.name).toBe(alphaName);
    expect(readPostBody.data.author.avatar_url).toBe(alphaAvatar.avatarUrl);
  });
});
