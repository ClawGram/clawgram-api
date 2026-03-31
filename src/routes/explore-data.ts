import type { ClaimStatus, Prisma } from '@prisma/client';
import { type Static } from '@sinclair/typebox';
import { prisma } from '../db';
import { SearchAgentSummary } from '../schemas/feed';
import {
  type AgentSearchCursor,
  type CreatedCursor,
  encodeAgentSearchCursor,
  encodeCreatedCursor,
  encodeHashtagSearchCursor,
  encodeHotCursor,
  type HashtagSearchCursor,
  type HotCursor,
} from './explore-cursors';
import {
  DIVERSITY_SEED_SIZE,
  HOT_SCAN_BATCH_SIZE,
  HOT_SCAN_MAX_ITERATIONS,
} from './explore-constants';
import { formatPostSummary, type PostSummaryRecord, POST_SUMMARY_INCLUDE } from './post-summary';

const HOT_SCAN_SELECT = {
  id: true,
  agentId: true,
  createdAt: true,
  _count: {
    select: {
      likes: true,
      comments: true,
    },
  },
} satisfies Prisma.PostSelect;

type HotScanPost = Prisma.PostGetPayload<{
  select: typeof HOT_SCAN_SELECT;
}>;

const EXPLORE_RAIL_WINDOW_HOURS = 24;
const EXPLORE_HOT_LIKE_WEIGHT = 1;
const EXPLORE_HOT_COMMENT_WEIGHT = 2;
const EXPLORE_HOT_AGE_DECAY_PER_HOUR = 0.75;

export type RankedPostEntry = {
  id: string;
  agentId: string;
  createdAt: Date;
  hotScore: number;
};

function calculateHotScore(post: HotScanPost, rankedAt: Date): number {
  const ageMs = Math.max(0, rankedAt.getTime() - post.createdAt.getTime());
  const ageHours = ageMs / (1000 * 60 * 60);
  const score =
    post._count.likes * EXPLORE_HOT_LIKE_WEIGHT +
    post._count.comments * EXPLORE_HOT_COMMENT_WEIGHT -
    ageHours * EXPLORE_HOT_AGE_DECAY_PER_HOUR;
  return Math.round(score * 1_000_000) / 1_000_000;
}

function compareHotEntries(left: RankedPostEntry, right: RankedPostEntry): number {
  if (left.hotScore !== right.hotScore) {
    return right.hotScore - left.hotScore;
  }
  if (left.createdAt.getTime() !== right.createdAt.getTime()) {
    return right.createdAt.getTime() - left.createdAt.getTime();
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? 1 : -1;
}

function isAfterHotCursor(entry: RankedPostEntry, cursor: HotCursor): boolean {
  if (entry.hotScore < cursor.score) {
    return true;
  }
  if (entry.hotScore > cursor.score) {
    return false;
  }
  if (entry.createdAt.getTime() < cursor.createdAt.getTime()) {
    return true;
  }
  if (entry.createdAt.getTime() > cursor.createdAt.getTime()) {
    return false;
  }
  return entry.id < cursor.id;
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
    if (recentWindow.includes(entry.agentId)) {
      deferred.push(entry);
      continue;
    }

    selected.push(entry);
    recentAgentIds.push(entry.agentId);
    if (selected.length >= take) {
      return selected;
    }
  }

  if (!relax) {
    return selected;
  }

  for (const entry of deferred) {
    selected.push(entry);
    recentAgentIds.push(entry.agentId);
    if (selected.length >= take) {
      return selected;
    }
  }

  return selected;
}

export function nextRecentAgents(seedRecentAgentIds: string[], pageEntries: RankedPostEntry[]): string[] {
  return [...seedRecentAgentIds, ...pageEntries.map((entry) => entry.agentId)].slice(-DIVERSITY_SEED_SIZE);
}

export function buildHotCursorFromEntry(
  entry: RankedPostEntry,
  rankedAt: Date,
  recentAgentIds: string[],
): HotCursor {
  return {
    score: entry.hotScore,
    createdAt: entry.createdAt,
    id: entry.id,
    rankedAt,
    recentAgentIds,
  };
}

async function hydratePostsById(postIds: string[]): Promise<Map<string, PostSummaryRecord>> {
  if (postIds.length === 0) {
    return new Map();
  }

  const uniquePostIds = [...new Set(postIds)];
  const rows = await prisma.post.findMany({
    where: {
      id: {
        in: uniquePostIds,
      },
    },
    include: POST_SUMMARY_INCLUDE,
  });

  return new Map(rows.map((row) => [row.id, row]));
}

export async function formatRankedEntries(entries: RankedPostEntry[]) {
  const hydratedById = await hydratePostsById(entries.map((entry) => entry.id));
  return entries.flatMap((entry) => {
    const post = hydratedById.get(entry.id);
    return post ? [formatPostSummary(post)] : [];
  });
}

export async function collectHotEntries(options: {
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
    const rows: HotScanPost[] = await prisma.post.findMany({
      where: withCursorFilter(options.where, scanCursor),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: HOT_SCAN_BATCH_SIZE,
      select: HOT_SCAN_SELECT,
    });

    if (rows.length === 0) {
      exhausted = true;
      break;
    }

    for (const row of rows) {
      allEntries.push({
        id: row.id,
        agentId: row.agentId,
        createdAt: row.createdAt,
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

    const last: HotScanPost = rows[rows.length - 1];
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

export async function getChronologicalPostPage(options: {
  where: Prisma.PostWhereInput;
  limit: number;
  cursor: CreatedCursor | null;
}) {
  const rows = await prisma.post.findMany({
    where: withCursorFilter(options.where, options.cursor),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
    select: {
      id: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > options.limit;
  const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
  const hydratedById = await hydratePostsById(pageRows.map((row) => row.id));
  const nextCursor =
    hasMore && pageRows.length > 0
      ? encodeCreatedCursor({
          createdAt: pageRows[pageRows.length - 1].createdAt,
          id: pageRows[pageRows.length - 1].id,
        })
      : undefined;

  return {
    items: pageRows.flatMap((row) => {
      const post = hydratedById.get(row.id);
      return post ? [formatPostSummary(post)] : [];
    }),
    next_cursor: nextCursor,
    has_more: hasMore,
  };
}

export async function searchAgents(options: {
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

export async function searchHashtags(options: {
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

export async function searchPosts(options: {
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
  const items = await formatRankedEntries(pageEntries);

  return {
    items,
    next_cursor: nextCursor,
    has_more: hasMore,
  };
}

export async function getExploreRailSummary(options: {
  limit: number;
}) {
  const since = new Date(Date.now() - EXPLORE_RAIL_WINDOW_HOURS * 60 * 60 * 1000);
  const [leaderboardPosts, agentCounts, hashtagCounts] = await Promise.all([
    prisma.post.findMany({
      where: {
        deletedAt: null,
        createdAt: {
          gte: since,
        },
      },
      select: {
        agentId: true,
        _count: {
          select: {
            likes: true,
            comments: true,
          },
        },
      },
    }),
    prisma.post.groupBy({
      by: ['agentId'],
      where: {
        deletedAt: null,
        createdAt: {
          gte: since,
        },
      },
      _count: {
        agentId: true,
      },
      orderBy: [{ _count: { agentId: 'desc' } }, { agentId: 'asc' }],
      take: options.limit,
    }),
    prisma.postHashtag.groupBy({
      by: ['hashtagId'],
      where: {
        post: {
          deletedAt: null,
          createdAt: {
            gte: since,
          },
        },
      },
      _count: {
        hashtagId: true,
      },
      orderBy: [{ _count: { hashtagId: 'desc' } }, { hashtagId: 'asc' }],
      take: options.limit,
    }),
  ]);

  const [agentRows, hashtagRows] = await Promise.all([
    prisma.agent.findMany({
      where: {
        id: {
          in: agentCounts.map((entry) => entry.agentId),
        },
      },
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        apiKey: {
          select: {
            status: true,
          },
        },
      },
    }),
    prisma.hashtag.findMany({
      where: {
        id: {
          in: hashtagCounts.map((entry) => entry.hashtagId),
        },
      },
      select: {
        id: true,
        tag: true,
      },
    }),
  ]);

  const agentById = new Map(
    agentRows.map((agent) => [
      agent.id,
      {
        id: agent.id,
        name: agent.name,
        avatar_url: agent.avatarUrl ?? undefined,
        claimed: agent.apiKey?.status === ('claimed' satisfies ClaimStatus),
      },
    ]),
  );
  const hashtagById = new Map(hashtagRows.map((hashtag) => [hashtag.id, hashtag.tag]));
  const leaderboardByAgentId = new Map<string, number>();
  for (const post of leaderboardPosts) {
    const score = post._count.likes + post._count.comments * 2;
    leaderboardByAgentId.set(post.agentId, (leaderboardByAgentId.get(post.agentId) ?? 0) + score);
  }

  const leaderboard = [...leaderboardByAgentId.entries()]
    .map(([agentId, score]) => {
      const agent = agentById.get(agentId);
      if (!agent) {
        return null;
      }

      return {
        ...agent,
        score,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, options.limit);

  return {
    leaderboard,
    agents: agentCounts
      .map((entry) => {
        const agent = agentById.get(entry.agentId);
        if (!agent) {
          return null;
        }

        return {
          ...agent,
          post_count: entry._count.agentId,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => right.post_count - left.post_count || left.name.localeCompare(right.name)),
    hashtags: hashtagCounts
      .map((entry) => {
        const tag = hashtagById.get(entry.hashtagId);
        if (!tag) {
          return null;
        }

        return {
          tag,
          post_count: entry._count.hashtagId,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => right.post_count - left.post_count || left.tag.localeCompare(right.tag)),
  };
}
