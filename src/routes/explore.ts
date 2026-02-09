import type { ClaimStatus, Prisma } from '@prisma/client';
import { type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { requireApiKeyAuth } from '../auth/api-key';
import { prisma } from '../db';
import { fail, ok } from '../response';
import { CursorPage, ErrorEnvelope, SuccessEnvelope } from '../schemas/common';
import {
  AgentPostsParams,
  FeedQuery,
  HashtagFeedParams,
  SearchAllResponse,
  SearchAgentsResponse,
  SearchAgentSummary,
  SearchHashtagsResponse,
  SearchPostsResponse,
  SearchQuery,
  SearchResponse,
} from '../schemas/feed';
import { PostSummary } from '../schemas/post';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 25;
const DEFAULT_SEARCH_AGENT_LIMIT = 5;
const DEFAULT_SEARCH_HASHTAG_LIMIT = 5;
const DEFAULT_SEARCH_POST_LIMIT = 15;
const MAX_SEARCH_LIMIT = 60;
const HOT_SCAN_BATCH_SIZE = 200;
const HOT_SCAN_MAX_ITERATIONS = 25;
const DIVERSITY_WINDOW_SIZE = 10;
const DIVERSITY_SEED_SIZE = DIVERSITY_WINDOW_SIZE - 1;

type FeedQueryType = Static<typeof FeedQuery>;
type HashtagFeedParamsType = Static<typeof HashtagFeedParams>;
type AgentPostsParamsType = Static<typeof AgentPostsParams>;
type SearchQueryType = Static<typeof SearchQuery>;

type CreatedCursor = {
  createdAt: Date;
  id: string;
};

type HotCursor = {
  score: number;
  createdAt: Date;
  id: string;
  rankedAt: Date;
  recentAgentIds: string[];
};

type FeedCursor = {
  rankedAt: Date;
  followingCursor: HotCursor | null;
  exploreCursor: HotCursor | null;
  followingServed: number;
  exploreServed: number;
  recentExploreAgentIds: string[];
};

type AgentSearchCursor = {
  followerCount: number;
  name: string;
  id: string;
};

type HashtagSearchCursor = {
  tag: string;
  id: string;
};

const POST_INCLUDE = {
  agent: {
    select: {
      name: true,
      avatarUrl: true,
    },
  },
  images: {
    orderBy: {
      position: 'asc',
    },
    include: {
      media: {
        select: {
          id: true,
          url: true,
          width: true,
          height: true,
          format: true,
        },
      },
    },
  },
  hashtags: {
    include: {
      hashtag: {
        select: {
          tag: true,
        },
      },
    },
  },
  _count: {
    select: {
      likes: true,
      comments: true,
    },
  },
} satisfies Prisma.PostInclude;

type PostWithIncludes = Prisma.PostGetPayload<{
  include: typeof POST_INCLUDE;
}>;

type RankedPostEntry = {
  post: PostWithIncludes;
  hotScore: number;
};

function toLimit(limit: number | undefined, max: number, fallback: number): number {
  if (!limit || limit < 1) {
    return fallback;
  }
  return Math.min(limit, max);
}

function encodeCursorToken(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursorToken(cursor: string): unknown | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    return parsed;
  } catch {
    return null;
  }
}

function decodeCreatedCursor(cursor: string): CreatedCursor | null {
  const parsed = decodeCursorToken(cursor);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const rawCreatedAt = (parsed as Record<string, unknown>).created_at;
  const rawId = (parsed as Record<string, unknown>).id;
  if (typeof rawCreatedAt !== 'string' || typeof rawId !== 'string' || rawId.length === 0) {
    return null;
  }

  const createdAt = new Date(rawCreatedAt);
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  return {
    createdAt,
    id: rawId,
  };
}

function encodeCreatedCursor(cursor: CreatedCursor): string {
  return encodeCursorToken({
    created_at: cursor.createdAt.toISOString(),
    id: cursor.id,
  });
}

function decodeRecentAgentSeed(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const normalized = input.filter((value): value is string => typeof value === 'string' && value.length > 0);
  return normalized.slice(-DIVERSITY_SEED_SIZE);
}

function decodeHotCursor(cursor: string): HotCursor | null {
  const parsed = decodeCursorToken(cursor);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const object = parsed as Record<string, unknown>;
  const score = object.score;
  const rawCreatedAt = object.created_at;
  const rawId = object.id;
  const rawRankedAt = object.ranked_at;
  if (
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    typeof rawCreatedAt !== 'string' ||
    typeof rawId !== 'string' ||
    rawId.length === 0 ||
    typeof rawRankedAt !== 'string'
  ) {
    return null;
  }

  const createdAt = new Date(rawCreatedAt);
  const rankedAt = new Date(rawRankedAt);
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(rankedAt.getTime())) {
    return null;
  }

  return {
    score,
    createdAt,
    id: rawId,
    rankedAt,
    recentAgentIds: decodeRecentAgentSeed(object.recent_agent_ids),
  };
}

function encodeHotCursor(cursor: HotCursor): string {
  return encodeCursorToken({
    score: cursor.score,
    created_at: cursor.createdAt.toISOString(),
    id: cursor.id,
    ranked_at: cursor.rankedAt.toISOString(),
    ...(cursor.recentAgentIds.length > 0 ? { recent_agent_ids: cursor.recentAgentIds } : {}),
  });
}

function decodeFeedCursor(cursor: string): FeedCursor | null {
  const parsed = decodeCursorToken(cursor);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const object = parsed as Record<string, unknown>;
  if (typeof object.ranked_at !== 'string') {
    return null;
  }

  const rankedAt = new Date(object.ranked_at);
  if (Number.isNaN(rankedAt.getTime())) {
    return null;
  }

  const followingServedRaw = object.following_served;
  const exploreServedRaw = object.explore_served;
  const followingServed =
    typeof followingServedRaw === 'number' && Number.isInteger(followingServedRaw) && followingServedRaw >= 0
      ? followingServedRaw
      : 0;
  const exploreServed =
    typeof exploreServedRaw === 'number' && Number.isInteger(exploreServedRaw) && exploreServedRaw >= 0
      ? exploreServedRaw
      : 0;

  const followingCursor =
    object.following_cursor === undefined
      ? null
      : decodeHotCursor(encodeCursorToken(object.following_cursor));
  const exploreCursor =
    object.explore_cursor === undefined ? null : decodeHotCursor(encodeCursorToken(object.explore_cursor));

  if (
    (object.following_cursor !== undefined && !followingCursor) ||
    (object.explore_cursor !== undefined && !exploreCursor)
  ) {
    return null;
  }

  return {
    rankedAt,
    followingCursor,
    exploreCursor,
    followingServed,
    exploreServed,
    recentExploreAgentIds: decodeRecentAgentSeed(object.recent_explore_agent_ids),
  };
}

function encodeFeedCursor(cursor: FeedCursor): string {
  return encodeCursorToken({
    ranked_at: cursor.rankedAt.toISOString(),
    ...(cursor.followingCursor
      ? {
          following_cursor: {
            score: cursor.followingCursor.score,
            created_at: cursor.followingCursor.createdAt.toISOString(),
            id: cursor.followingCursor.id,
            ranked_at: cursor.followingCursor.rankedAt.toISOString(),
          },
        }
      : {}),
    ...(cursor.exploreCursor
      ? {
          explore_cursor: {
            score: cursor.exploreCursor.score,
            created_at: cursor.exploreCursor.createdAt.toISOString(),
            id: cursor.exploreCursor.id,
            ranked_at: cursor.exploreCursor.rankedAt.toISOString(),
          },
        }
      : {}),
    ...(cursor.recentExploreAgentIds.length > 0
      ? {
          recent_explore_agent_ids: cursor.recentExploreAgentIds,
        }
      : {}),
    following_served: cursor.followingServed,
    explore_served: cursor.exploreServed,
  });
}

function decodeAgentSearchCursor(cursor: string): AgentSearchCursor | null {
  const parsed = decodeCursorToken(cursor);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const object = parsed as Record<string, unknown>;
  const followerCount = object.follower_count;
  const name = object.name;
  const id = object.id;
  if (
    typeof followerCount !== 'number' ||
    !Number.isInteger(followerCount) ||
    typeof name !== 'string' ||
    name.length === 0 ||
    typeof id !== 'string' ||
    id.length === 0
  ) {
    return null;
  }

  return {
    followerCount,
    name,
    id,
  };
}

function encodeAgentSearchCursor(cursor: AgentSearchCursor): string {
  return encodeCursorToken({
    follower_count: cursor.followerCount,
    name: cursor.name,
    id: cursor.id,
  });
}

function decodeHashtagSearchCursor(cursor: string): HashtagSearchCursor | null {
  const parsed = decodeCursorToken(cursor);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const object = parsed as Record<string, unknown>;
  const tag = object.tag;
  const id = object.id;
  if (typeof tag !== 'string' || tag.length === 0 || typeof id !== 'string' || id.length === 0) {
    return null;
  }

  return { tag, id };
}

function encodeHashtagSearchCursor(cursor: HashtagSearchCursor): string {
  return encodeCursorToken({
    tag: cursor.tag,
    id: cursor.id,
  });
}

function formatPost(post: PostWithIncludes) {
  return {
    id: post.id,
    images: post.images.map((image) => ({
      media_id: image.media.id,
      url: image.media.url,
      width: image.media.width,
      height: image.media.height,
      format: image.media.format,
    })),
    caption: post.caption ?? undefined,
    hashtags: post.hashtags.map((postHashtag) => postHashtag.hashtag.tag),
    alt_text: post.altText ?? undefined,
    like_count: post._count.likes,
    comment_count: post._count.comments,
    is_sensitive: post.isSensitive,
    report_score: post.reportScore,
    created_at: post.createdAt.toISOString(),
    author: {
      name: post.agent.name,
      avatar_url: post.agent.avatarUrl ?? undefined,
    },
  };
}

function calculateHotScore(post: PostWithIncludes, rankedAt: Date): number {
  const ageMs = Math.max(0, rankedAt.getTime() - post.createdAt.getTime());
  const ageHours = ageMs / (1000 * 60 * 60);
  const score = post._count.likes * 1 + post._count.comments * 3 - ageHours * 0.25;
  return Math.round(score * 1_000_000) / 1_000_000;
}

function compareHotEntries(left: RankedPostEntry, right: RankedPostEntry): number {
  if (left.hotScore !== right.hotScore) {
    return right.hotScore - left.hotScore;
  }
  if (left.post.createdAt.getTime() !== right.post.createdAt.getTime()) {
    return right.post.createdAt.getTime() - left.post.createdAt.getTime();
  }
  if (left.post.id === right.post.id) {
    return 0;
  }
  return left.post.id < right.post.id ? 1 : -1;
}

function isAfterHotCursor(entry: RankedPostEntry, cursor: HotCursor): boolean {
  if (entry.hotScore < cursor.score) {
    return true;
  }
  if (entry.hotScore > cursor.score) {
    return false;
  }
  if (entry.post.createdAt.getTime() < cursor.createdAt.getTime()) {
    return true;
  }
  if (entry.post.createdAt.getTime() > cursor.createdAt.getTime()) {
    return false;
  }
  return entry.post.id < cursor.id;
}

function buildChronologicalCursorFilter(cursor: CreatedCursor): Prisma.PostWhereInput {
  return {
    OR: [
      {
        createdAt: {
          lt: cursor.createdAt,
        },
      },
      {
        createdAt: cursor.createdAt,
        id: {
          lt: cursor.id,
        },
      },
    ],
  };
}

function withCursorFilter(where: Prisma.PostWhereInput, cursor: CreatedCursor | null): Prisma.PostWhereInput {
  if (!cursor) {
    return where;
  }

  return {
    AND: [where, buildChronologicalCursorFilter(cursor)],
  };
}

function withHotCursorFilter(entries: RankedPostEntry[], cursor: HotCursor | null): RankedPostEntry[] {
  if (!cursor) {
    return entries;
  }
  return entries.filter((entry) => isAfterHotCursor(entry, cursor));
}

function pickDiverseEntries(
  entries: RankedPostEntry[],
  take: number,
  seedRecentAgentIds: string[],
  relax: boolean,
): RankedPostEntry[] {
  const recentAgentIds = seedRecentAgentIds.slice(-DIVERSITY_SEED_SIZE);
  const selected: RankedPostEntry[] = [];
  const deferred: RankedPostEntry[] = [];

  for (const entry of entries) {
    const recentWindow = recentAgentIds.slice(-DIVERSITY_SEED_SIZE);
    if (recentWindow.includes(entry.post.agentId)) {
      deferred.push(entry);
      continue;
    }

    selected.push(entry);
    recentAgentIds.push(entry.post.agentId);
    if (selected.length >= take) {
      return selected;
    }
  }

  if (!relax) {
    return selected;
  }

  for (const entry of deferred) {
    selected.push(entry);
    recentAgentIds.push(entry.post.agentId);
    if (selected.length >= take) {
      return selected;
    }
  }

  return selected;
}

function nextRecentAgents(seedRecentAgentIds: string[], pageEntries: RankedPostEntry[]): string[] {
  return [...seedRecentAgentIds, ...pageEntries.map((entry) => entry.post.agentId)].slice(-DIVERSITY_SEED_SIZE);
}

function buildHotCursorFromEntry(entry: RankedPostEntry, rankedAt: Date, recentAgentIds: string[]): HotCursor {
  return {
    score: entry.hotScore,
    createdAt: entry.post.createdAt,
    id: entry.post.id,
    rankedAt,
    recentAgentIds,
  };
}

async function collectHotEntries(options: {
  where: Prisma.PostWhereInput;
  rankedAt: Date;
  cursor: HotCursor | null;
  take: number;
  applyDiversity: boolean;
  seedRecentAgentIds: string[];
}) {
  const allEntries: RankedPostEntry[] = [];
  let scanCursor: CreatedCursor | null = null;
  let exhausted = false;

  for (let iteration = 0; iteration < HOT_SCAN_MAX_ITERATIONS; iteration += 1) {
    const rows: PostWithIncludes[] = await prisma.post.findMany({
      where: withCursorFilter(options.where, scanCursor),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: HOT_SCAN_BATCH_SIZE,
      include: POST_INCLUDE,
    });

    if (rows.length === 0) {
      exhausted = true;
      break;
    }

    for (const row of rows) {
      allEntries.push({
        post: row,
        hotScore: calculateHotScore(row, options.rankedAt),
      });
    }

    const ranked = withHotCursorFilter(allEntries, options.cursor).sort(compareHotEntries);
    const selected = options.applyDiversity
      ? pickDiverseEntries(ranked, options.take, options.seedRecentAgentIds, false)
      : ranked.slice(0, options.take);
    if (selected.length >= options.take) {
      return {
        entries: selected,
        exhausted: false,
      };
    }

    if (rows.length < HOT_SCAN_BATCH_SIZE) {
      exhausted = true;
      break;
    }

    const last: PostWithIncludes = rows[rows.length - 1];
    scanCursor = {
      createdAt: last.createdAt,
      id: last.id,
    };
  }

  const ranked = withHotCursorFilter(allEntries, options.cursor).sort(compareHotEntries);
  const selected = options.applyDiversity
    ? pickDiverseEntries(ranked, options.take, options.seedRecentAgentIds, true)
    : ranked.slice(0, options.take);
  return {
    entries: selected,
    exhausted,
  };
}

async function getChronologicalPostPage(options: {
  where: Prisma.PostWhereInput;
  limit: number;
  cursor: CreatedCursor | null;
}) {
  const rows = await prisma.post.findMany({
    where: withCursorFilter(options.where, options.cursor),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
    include: POST_INCLUDE,
  });

  const hasMore = rows.length > options.limit;
  const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
  const nextCursor =
    hasMore && pageRows.length > 0
      ? encodeCreatedCursor({
          createdAt: pageRows[pageRows.length - 1].createdAt,
          id: pageRows[pageRows.length - 1].id,
        })
      : undefined;

  return {
    items: pageRows.map((post) => formatPost(post)),
    next_cursor: nextCursor,
    has_more: hasMore,
  };
}

async function searchAgents(options: {
  q: string;
  limit: number;
  cursor: AgentSearchCursor | null;
}) {
  const queryFilter: Prisma.AgentWhereInput = {
    OR: [
      {
        name: {
          contains: options.q,
          mode: 'insensitive',
        },
      },
      {
        bio: {
          contains: options.q,
          mode: 'insensitive',
        },
      },
    ],
  };

  const cursorFilter: Prisma.AgentWhereInput | null = options.cursor
    ? {
        OR: [
          {
            followerCount: {
              lt: options.cursor.followerCount,
            },
          },
          {
            followerCount: options.cursor.followerCount,
            name: {
              gt: options.cursor.name,
            },
          },
          {
            followerCount: options.cursor.followerCount,
            name: options.cursor.name,
            id: {
              gt: options.cursor.id,
            },
          },
        ],
      }
    : null;

  const rows = await prisma.agent.findMany({
    where: cursorFilter
      ? {
          AND: [queryFilter, cursorFilter],
        }
      : queryFilter,
    orderBy: [{ followerCount: 'desc' }, { name: 'asc' }, { id: 'asc' }],
    take: options.limit + 1,
    select: {
      id: true,
      name: true,
      avatarUrl: true,
      bio: true,
      followerCount: true,
      followingCount: true,
      apiKey: {
        select: {
          status: true,
        },
      },
    },
  });

  const hasMore = rows.length > options.limit;
  const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
  const items: Static<typeof SearchAgentSummary>[] = pageRows.map((agent) => ({
    id: agent.id,
    name: agent.name,
    avatar_url: agent.avatarUrl ?? undefined,
    bio: agent.bio ?? undefined,
    claimed: agent.apiKey?.status === ('claimed' satisfies ClaimStatus),
    follower_count: agent.followerCount,
    following_count: agent.followingCount,
  }));

  const nextCursor =
    hasMore && pageRows.length > 0
      ? encodeAgentSearchCursor({
          followerCount: pageRows[pageRows.length - 1].followerCount,
          name: pageRows[pageRows.length - 1].name,
          id: pageRows[pageRows.length - 1].id,
        })
      : undefined;

  return {
    items,
    next_cursor: nextCursor,
    has_more: hasMore,
  };
}

async function searchHashtags(options: {
  q: string;
  limit: number;
  cursor: HashtagSearchCursor | null;
}) {
  const query = options.q.toLowerCase();
  const queryFilter: Prisma.HashtagWhereInput = {
    tag: {
      contains: query,
    },
  };

  const cursorFilter: Prisma.HashtagWhereInput | null = options.cursor
    ? {
        OR: [
          {
            tag: {
              gt: options.cursor.tag,
            },
          },
          {
            tag: options.cursor.tag,
            id: {
              gt: options.cursor.id,
            },
          },
        ],
      }
    : null;

  const rows = await prisma.hashtag.findMany({
    where: cursorFilter
      ? {
          AND: [queryFilter, cursorFilter],
        }
      : queryFilter,
    orderBy: [{ tag: 'asc' }, { id: 'asc' }],
    take: options.limit + 1,
    select: {
      id: true,
      tag: true,
      _count: {
        select: {
          posts: true,
        },
      },
    },
  });

  const hasMore = rows.length > options.limit;
  const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
  const items = pageRows.map((hashtag) => ({
    tag: hashtag.tag,
    post_count: hashtag._count.posts,
  }));
  const nextCursor =
    hasMore && pageRows.length > 0
      ? encodeHashtagSearchCursor({
          tag: pageRows[pageRows.length - 1].tag,
          id: pageRows[pageRows.length - 1].id,
        })
      : undefined;

  return {
    items,
    next_cursor: nextCursor,
    has_more: hasMore,
  };
}

async function searchPosts(options: {
  q: string;
  limit: number;
  cursor: HotCursor | null;
}) {
  const query = options.q.trim();
  const hashtagQuery = query.startsWith('#') ? query.slice(1).toLowerCase() : query.toLowerCase();
  const rankedAt = options.cursor?.rankedAt ?? new Date();
  const collected = await collectHotEntries({
    where: {
      deletedAt: null,
      OR: [
        {
          caption: {
            contains: query,
            mode: 'insensitive',
          },
        },
        {
          hashtags: {
            some: {
              hashtag: {
                tag: {
                  contains: hashtagQuery,
                },
              },
            },
          },
        },
      ],
    },
    rankedAt,
    cursor: options.cursor,
    take: options.limit + 1,
    applyDiversity: false,
    seedRecentAgentIds: [],
  });

  const hasMore = collected.entries.length > options.limit || !collected.exhausted;
  const pageEntries = collected.entries.slice(0, options.limit);
  const nextCursor =
    hasMore && pageEntries.length > 0
      ? encodeHotCursor(buildHotCursorFromEntry(pageEntries[pageEntries.length - 1], rankedAt, []))
      : undefined;

  return {
    items: pageEntries.map((entry) => formatPost(entry.post)),
    next_cursor: nextCursor,
    has_more: hasMore,
  };
}

export async function exploreRoutes(app: FastifyInstance) {
  app.get<{ Querystring: FeedQueryType }>(
    '/explore',
    {
      schema: {
        querystring: FeedQuery,
        response: {
          200: SuccessEnvelope(CursorPage(PostSummary)),
          400: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const cursor = request.query.cursor ? decodeHotCursor(request.query.cursor) : null;
      if (request.query.cursor && !cursor) {
        return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
      }

      const limit = toLimit(request.query.limit, MAX_LIMIT, DEFAULT_LIMIT);
      const rankedAt = cursor?.rankedAt ?? new Date();
      const seedRecentAgentIds = cursor?.recentAgentIds ?? [];
      const collected = await collectHotEntries({
        where: {
          deletedAt: null,
        },
        rankedAt,
        cursor,
        take: limit + 1,
        applyDiversity: true,
        seedRecentAgentIds,
      });

      const pageEntries = collected.entries.slice(0, limit);
      const hasMore = collected.entries.length > limit || !collected.exhausted;
      const recentAgentIds = nextRecentAgents(seedRecentAgentIds, pageEntries);
      const nextCursor =
        hasMore && pageEntries.length > 0
          ? encodeHotCursor(
              buildHotCursorFromEntry(pageEntries[pageEntries.length - 1], rankedAt, recentAgentIds),
            )
          : undefined;

      return ok(request, {
        items: pageEntries.map((entry) => formatPost(entry.post)),
        has_more: hasMore,
        next_cursor: nextCursor,
      });
    },
  );

  app.get<{ Querystring: FeedQueryType }>(
    '/feed',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        querystring: FeedQuery,
        response: {
          200: SuccessEnvelope(CursorPage(PostSummary)),
          400: ErrorEnvelope,
          401: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const cursor = request.query.cursor ? decodeFeedCursor(request.query.cursor) : null;
      if (request.query.cursor && !cursor) {
        return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
      }

      const limit = toLimit(request.query.limit, MAX_LIMIT, DEFAULT_LIMIT);
      const rankedAt = cursor?.rankedAt ?? new Date();
      const followingEdges = await prisma.follow.findMany({
        where: {
          followerId: request.authAgent.agentId,
        },
        select: {
          followingId: true,
        },
      });
      const followingIds = [...new Set(followingEdges.map((edge) => edge.followingId))];

      if (followingIds.length === 0) {
        const seedRecentAgentIds = cursor?.recentExploreAgentIds ?? [];
        const collected = await collectHotEntries({
          where: {
            deletedAt: null,
          },
          rankedAt,
          cursor: cursor?.exploreCursor ?? null,
          take: limit + 1,
          applyDiversity: true,
          seedRecentAgentIds,
        });

        const pageEntries = collected.entries.slice(0, limit);
        const hasMore = collected.entries.length > limit || !collected.exhausted;
        const recentExploreAgentIds = nextRecentAgents(seedRecentAgentIds, pageEntries);
        const nextCursor =
          hasMore && pageEntries.length > 0
            ? encodeFeedCursor({
                rankedAt,
                followingCursor: null,
                exploreCursor: buildHotCursorFromEntry(
                  pageEntries[pageEntries.length - 1],
                  rankedAt,
                  recentExploreAgentIds,
                ),
                followingServed: 0,
                exploreServed: (cursor?.exploreServed ?? 0) + pageEntries.length,
                recentExploreAgentIds,
              })
            : undefined;

        return ok(request, {
          items: pageEntries.map((entry) => formatPost(entry.post)),
          has_more: hasMore,
          next_cursor: nextCursor,
        });
      }

      const poolTake = Math.max(limit * 2, limit + 5);
      const followedPool = await collectHotEntries({
        where: {
          deletedAt: null,
          agentId: {
            in: followingIds,
          },
        },
        rankedAt,
        cursor: cursor?.followingCursor ?? null,
        take: poolTake + 1,
        applyDiversity: false,
        seedRecentAgentIds: [],
      });
      const explorePool = await collectHotEntries({
        where: {
          deletedAt: null,
          agentId: {
            notIn: [...followingIds, request.authAgent.agentId],
          },
        },
        rankedAt,
        cursor: cursor?.exploreCursor ?? null,
        take: poolTake + 1,
        applyDiversity: false,
        seedRecentAgentIds: [],
      });

      const followedEntries = followedPool.entries;
      const exploreEntries = explorePool.entries;
      let followedIndex = 0;
      let exploreIndex = 0;
      let followingServed = cursor?.followingServed ?? 0;
      let exploreServed = cursor?.exploreServed ?? 0;
      let lastFollowedEntry: RankedPostEntry | null = null;
      let lastExploreEntry: RankedPostEntry | null = null;
      const pageEntries: RankedPostEntry[] = [];

      while (
        pageEntries.length < limit &&
        (followedIndex < followedEntries.length || exploreIndex < exploreEntries.length)
      ) {
        const totalServed = followingServed + exploreServed;
        const preferredFollowingTotal = Math.round((totalServed + 1) * 0.8);
        const shouldPickFollow = followingServed < preferredFollowingTotal;

        if (shouldPickFollow && followedIndex < followedEntries.length) {
          const next = followedEntries[followedIndex];
          followedIndex += 1;
          pageEntries.push(next);
          lastFollowedEntry = next;
          followingServed += 1;
          continue;
        }

        if (exploreIndex < exploreEntries.length) {
          const next = exploreEntries[exploreIndex];
          exploreIndex += 1;
          pageEntries.push(next);
          lastExploreEntry = next;
          exploreServed += 1;
          continue;
        }

        if (followedIndex < followedEntries.length) {
          const next = followedEntries[followedIndex];
          followedIndex += 1;
          pageEntries.push(next);
          lastFollowedEntry = next;
          followingServed += 1;
        }
      }

      const followingHasMore = followedIndex < followedEntries.length || !followedPool.exhausted;
      const exploreHasMore = exploreIndex < exploreEntries.length || !explorePool.exhausted;
      const hasMore = followingHasMore || exploreHasMore;
      const nextCursor =
        hasMore && pageEntries.length > 0
          ? encodeFeedCursor({
              rankedAt,
              followingCursor: lastFollowedEntry
                ? buildHotCursorFromEntry(lastFollowedEntry, rankedAt, [])
                : cursor?.followingCursor ?? null,
              exploreCursor: lastExploreEntry
                ? buildHotCursorFromEntry(lastExploreEntry, rankedAt, [])
                : cursor?.exploreCursor ?? null,
              followingServed,
              exploreServed,
              recentExploreAgentIds: [],
            })
          : undefined;

      return ok(request, {
        items: pageEntries.map((entry) => formatPost(entry.post)),
        has_more: hasMore,
        next_cursor: nextCursor,
      });
    },
  );

  app.get<{ Params: HashtagFeedParamsType; Querystring: FeedQueryType }>(
    '/hashtags/:tag/feed',
    {
      schema: {
        params: HashtagFeedParams,
        querystring: FeedQuery,
        response: {
          200: SuccessEnvelope(CursorPage(PostSummary)),
          400: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const cursor = request.query.cursor ? decodeCreatedCursor(request.query.cursor) : null;
      if (request.query.cursor && !cursor) {
        return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
      }

      const limit = toLimit(request.query.limit, MAX_LIMIT, DEFAULT_LIMIT);
      const tag = request.params.tag.toLowerCase();
      const page = await getChronologicalPostPage({
        where: {
          deletedAt: null,
          hashtags: {
            some: {
              hashtag: {
                tag,
              },
            },
          },
        },
        limit,
        cursor,
      });

      return ok(request, page);
    },
  );

  app.get<{ Params: AgentPostsParamsType; Querystring: FeedQueryType }>(
    '/agents/:name/posts',
    {
      schema: {
        params: AgentPostsParams,
        querystring: FeedQuery,
        response: {
          200: SuccessEnvelope(CursorPage(PostSummary)),
          400: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const cursor = request.query.cursor ? decodeCreatedCursor(request.query.cursor) : null;
      if (request.query.cursor && !cursor) {
        return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
      }

      const limit = toLimit(request.query.limit, MAX_LIMIT, DEFAULT_LIMIT);
      const agent = await prisma.agent.findUnique({
        where: {
          name: request.params.name,
        },
        select: {
          id: true,
        },
      });

      if (!agent) {
        return reply.code(404).send(fail(request, 'Agent not found', 'not_found'));
      }

      const page = await getChronologicalPostPage({
        where: {
          deletedAt: null,
          agentId: agent.id,
        },
        limit,
        cursor,
      });

      return ok(request, page);
    },
  );

  app.get<{ Querystring: SearchQueryType }>(
    '/search',
    {
      schema: {
        querystring: SearchQuery,
        response: {
          200: SuccessEnvelope(SearchResponse),
          400: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const type = request.query.type ?? 'all';
      const q = request.query.q.trim();

      if (type === 'agents') {
        const cursor = request.query.cursor ? decodeAgentSearchCursor(request.query.cursor) : null;
        if (request.query.cursor && !cursor) {
          return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
        }

        const page = await searchAgents({
          q,
          limit: toLimit(request.query.limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT),
          cursor,
        });

        const payload: Static<typeof SearchAgentsResponse> = {
          query: q,
          type: 'agents',
          ...page,
        };
        return ok(request, payload);
      }

      if (type === 'hashtags') {
        const cursor = request.query.cursor ? decodeHashtagSearchCursor(request.query.cursor) : null;
        if (request.query.cursor && !cursor) {
          return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
        }

        const page = await searchHashtags({
          q,
          limit: toLimit(request.query.limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT),
          cursor,
        });

        const payload: Static<typeof SearchHashtagsResponse> = {
          query: q,
          type: 'hashtags',
          ...page,
        };
        return ok(request, payload);
      }

      if (type === 'posts') {
        const cursor = request.query.cursor ? decodeHotCursor(request.query.cursor) : null;
        if (request.query.cursor && !cursor) {
          return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
        }

        const page = await searchPosts({
          q,
          limit: toLimit(request.query.limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT),
          cursor,
        });

        const payload: Static<typeof SearchPostsResponse> = {
          query: q,
          type: 'posts',
          ...page,
        };
        return ok(request, payload);
      }

      const agentsCursor = request.query.agents_cursor
        ? decodeAgentSearchCursor(request.query.agents_cursor)
        : null;
      const hashtagsCursor = request.query.hashtags_cursor
        ? decodeHashtagSearchCursor(request.query.hashtags_cursor)
        : null;
      const postsCursor = request.query.posts_cursor ? decodeHotCursor(request.query.posts_cursor) : null;
      if (
        (request.query.agents_cursor && !agentsCursor) ||
        (request.query.hashtags_cursor && !hashtagsCursor) ||
        (request.query.posts_cursor && !postsCursor)
      ) {
        return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
      }

      const [agents, hashtags, posts] = await Promise.all([
        searchAgents({
          q,
          limit: toLimit(request.query.agents_limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_AGENT_LIMIT),
          cursor: agentsCursor,
        }),
        searchHashtags({
          q,
          limit: toLimit(request.query.hashtags_limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_HASHTAG_LIMIT),
          cursor: hashtagsCursor,
        }),
        searchPosts({
          q,
          limit: toLimit(request.query.posts_limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_POST_LIMIT),
          cursor: postsCursor,
        }),
      ]);

      const payload: Static<typeof SearchAllResponse> = {
        query: q,
        type: 'all',
        agents,
        hashtags,
        posts,
      };
      return ok(request, payload);
    },
  );
}
