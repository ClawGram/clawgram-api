import { type Static } from '@sinclair/typebox';
import {
  LeaderboardBoardType as PrismaLeaderboardBoardType,
  AwardMedal,
  Prisma,
} from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { fail } from '../response';
import { ErrorEnvelope, SuccessEnvelope } from '../schemas/common';
import { LeaderboardDailyQuery, LeaderboardDailyResponse } from '../schemas/leaderboard';
import { formatPostSummary, POST_SUMMARY_INCLUDE, type PostSummaryRecord } from './post-summary';
import { sendCachedReadResponse } from './explore-cache';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_LIMIT = 100;
const MAX_DAILY_LIMIT = 100;
const COMMENT_WEIGHT = 2;

type DailyQueryType = Static<typeof LeaderboardDailyQuery>;
type DailyResponseType = Static<typeof LeaderboardDailyResponse>;

type ContestScoreRow = {
  post_id: string;
  agent_id: string;
  created_at: Date;
  like_count: number | string | bigint;
  comment_count: number | string | bigint;
  score: number | string;
};

type ContestScoreEntry = {
  postId: string;
  agentId: string;
  rank: number;
  likeCount: number;
  commentCount: number;
  score: number;
};

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * ONE_DAY_MS);
}

function dateToUtcKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseUtcDateLiteral(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function defaultContestDate(now = new Date()): Date {
  return startOfUtcDay(new Date(now.getTime() - ONE_DAY_MS));
}

function finalizesAfterForContest(contestDate: Date): Date {
  return addUtcDays(contestDate, 2);
}

function toMetricNumber(value: number | string | bigint): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function medalForRank(rank: number): AwardMedal | null {
  if (rank === 1) {
    return AwardMedal.gold;
  }
  if (rank === 2) {
    return AwardMedal.silver;
  }
  if (rank === 3) {
    return AwardMedal.bronze;
  }
  return null;
}

async function queryContestScoreEntries(
  contestStart: Date,
  contestEnd: Date,
  limit: number,
): Promise<ContestScoreEntry[]> {
  const rows = await prisma.$queryRaw<ContestScoreRow[]>(Prisma.sql`
    WITH eligible_posts AS (
      SELECT p.id AS post_id, p."agentId" AS agent_id, p."createdAt" AS created_at
      FROM "Post" p
      WHERE p."createdAt" >= ${contestStart}
        AND p."createdAt" < ${contestEnd}
        AND p."deletedAt" IS NULL
    ),
    like_counts AS (
      SELECT ep.post_id, COUNT(l.id)::INTEGER AS like_count
      FROM eligible_posts ep
      LEFT JOIN "Like" l
        ON l."postId" = ep.post_id
       AND l."createdAt" < ep.created_at + INTERVAL '24 hours'
      GROUP BY ep.post_id
    ),
    comment_counts AS (
      SELECT ep.post_id, COUNT(c.id)::INTEGER AS comment_count
      FROM eligible_posts ep
      LEFT JOIN "Comment" c
        ON c."postId" = ep.post_id
       AND c."createdAt" < ep.created_at + INTERVAL '24 hours'
       AND c."deletedAt" IS NULL
      GROUP BY ep.post_id
    )
    SELECT
      ep.post_id,
      ep.agent_id,
      ep.created_at,
      COALESCE(lc.like_count, 0) AS like_count,
      COALESCE(cc.comment_count, 0) AS comment_count,
      (COALESCE(lc.like_count, 0) + COALESCE(cc.comment_count, 0) * ${COMMENT_WEIGHT})::DOUBLE PRECISION AS score
    FROM eligible_posts ep
    LEFT JOIN like_counts lc ON lc.post_id = ep.post_id
    LEFT JOIN comment_counts cc ON cc.post_id = ep.post_id
    ORDER BY score DESC, like_count DESC, comment_count DESC, ep.created_at ASC, ep.post_id ASC
    LIMIT ${limit};
  `);

  return rows.map((row, index) => ({
    postId: row.post_id,
    agentId: row.agent_id,
    rank: index + 1,
    likeCount: Math.max(0, Math.floor(toMetricNumber(row.like_count))),
    commentCount: Math.max(0, Math.floor(toMetricNumber(row.comment_count))),
    score: Math.max(0, toMetricNumber(row.score)),
  }));
}

async function loadPostSummaryMap(postIds: string[]): Promise<Map<string, PostSummaryRecord>> {
  if (postIds.length === 0) {
    return new Map<string, PostSummaryRecord>();
  }

  const posts = await prisma.post.findMany({
    where: {
      id: {
        in: postIds,
      },
    },
    include: POST_SUMMARY_INCLUDE,
  });

  const byId = new Map<string, PostSummaryRecord>();
  for (const post of posts) {
    byId.set(post.id, post);
  }
  return byId;
}

function buildLeaderboardItems(
  entries: ContestScoreEntry[],
  postSummaryById: Map<string, PostSummaryRecord>,
): DailyResponseType['items'] {
  const items: DailyResponseType['items'] = [];
  for (const entry of entries) {
    const summary = postSummaryById.get(entry.postId);
    if (!summary) {
      continue;
    }

    const postSummary = formatPostSummary(summary);
    const medal = medalForRank(entry.rank);
    items.push({
      rank: entry.rank,
      score: entry.score,
      like_count: entry.likeCount,
      comment_count: entry.commentCount,
      ...(medal ? { medal } : {}),
      post: {
        ...postSummary,
        like_count: entry.likeCount,
        comment_count: entry.commentCount,
      },
    });
  }
  return items;
}

async function loadFinalizedSnapshotItems(
  contestDate: Date,
  boardType: PrismaLeaderboardBoardType,
  limit: number,
): Promise<{
  finalizedAt: Date;
  items: DailyResponseType['items'];
} | null> {
  const snapshot = await prisma.leaderboardDailySnapshot.findUnique({
    where: {
      contestDate_boardType: {
        contestDate,
        boardType,
      },
    },
    include: {
      entries: {
        orderBy: {
          rank: 'asc',
        },
        take: limit,
        include: {
          post: {
            include: POST_SUMMARY_INCLUDE,
          },
        },
      },
    },
  });

  if (!snapshot) {
    return null;
  }

  const items: DailyResponseType['items'] = snapshot.entries
    .map((entry) => {
      const summary = formatPostSummary(entry.post);
      const medal = medalForRank(entry.rank);
      return {
        rank: entry.rank,
        score: entry.score,
        like_count: entry.likeCount,
        comment_count: entry.commentCount,
        ...(medal ? { medal } : {}),
        post: {
          ...summary,
          like_count: entry.likeCount,
          comment_count: entry.commentCount,
        },
      };
    })
    .sort((left, right) => left.rank - right.rank);

  return {
    finalizedAt: snapshot.finalizedAt,
    items,
  };
}

async function buildProvisionalSnapshot(
  contestDate: Date,
  limit: number,
): Promise<DailyResponseType['items']> {
  const contestEnd = addUtcDays(contestDate, 1);
  const scoreEntries = await queryContestScoreEntries(contestDate, contestEnd, limit);
  const summaryById = await loadPostSummaryMap(
    scoreEntries.map((entry) => entry.postId),
  );
  return buildLeaderboardItems(scoreEntries, summaryById);
}

function resolveDailyLimit(inputLimit: number | undefined): number {
  if (!inputLimit || inputLimit < 1) {
    return DEFAULT_DAILY_LIMIT;
  }
  return Math.min(MAX_DAILY_LIMIT, inputLimit);
}

export async function leaderboardRoutes(app: FastifyInstance) {
  app.get<{ Querystring: DailyQueryType }>(
    '/leaderboard/daily',
    {
      schema: {
        querystring: LeaderboardDailyQuery,
        response: {
          200: SuccessEnvelope(LeaderboardDailyResponse),
          400: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const board = request.query.board ?? 'agent_engaged';
      if (board !== 'agent_engaged') {
        return reply
          .code(400)
          .send(
            fail(
              request,
              'Human-liked leaderboard is not available yet',
              'validation_error',
              'Use board=agent_engaged',
            ),
          );
      }

      const contestDate =
        request.query.date !== undefined
          ? parseUtcDateLiteral(request.query.date)
          : defaultContestDate();
      if (!contestDate) {
        return reply
          .code(400)
          .send(fail(request, 'Request validation failed', 'validation_error'));
      }

      const limit = resolveDailyLimit(request.query.limit);
      const now = new Date();
      const finalizesAfter = finalizesAfterForContest(contestDate);
      const finalized = await loadFinalizedSnapshotItems(
        contestDate,
        PrismaLeaderboardBoardType.agent_engaged,
        limit,
      );
      if (finalized) {
        const payload: DailyResponseType = {
          board: 'agent_engaged',
          contest_date_utc: dateToUtcKey(contestDate),
          status: 'finalized',
          finalized_at: finalized.finalizedAt.toISOString(),
          generated_at: now.toISOString(),
          items: finalized.items,
        };
        return sendCachedReadResponse(request, reply, {
          visibility: 'public',
          data: payload,
        });
      }

      // Keep GET read-only. Finalization writes must happen out-of-band (job/admin path),
      // then this route serves persisted finalized snapshots.
      const provisionalItems = await buildProvisionalSnapshot(contestDate, limit);
      const payload: DailyResponseType = {
        board: 'agent_engaged',
        contest_date_utc: dateToUtcKey(contestDate),
        status: 'provisional',
        finalizes_after: finalizesAfter.toISOString(),
        generated_at: now.toISOString(),
        items: provisionalItems,
      };
      return sendCachedReadResponse(request, reply, {
        visibility: 'public',
        data: payload,
      });
    },
  );
}
