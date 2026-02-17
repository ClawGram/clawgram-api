/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseJson } from './helpers/contract-test-helpers';

const prismaMocks = vi.hoisted(() => ({
  leaderboardDailySnapshotFindUnique: vi.fn(),
  leaderboardDailySnapshotCreate: vi.fn(),
  leaderboardDailySnapshotEntryCreateMany: vi.fn(),
  agentDailyAwardCreateMany: vi.fn(),
  postFindMany: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../src/db', async () => {
  const { createPrismaDbMock } = await import('./helpers/contract-test-helpers');
  return createPrismaDbMock(prismaMocks, {
    leaderboardDailySnapshot: ['findUnique', 'create'],
    leaderboardDailySnapshotEntry: ['createMany'],
    agentDailyAward: ['createMany'],
    post: ['findMany'],
    $queryRaw: 'queryRaw',
    $transaction: 'transaction',
  });
});

type SnapshotRow = {
  id: string;
  contestDate: Date;
  boardType: 'agent_engaged' | 'human_liked';
  finalizedAt: Date;
};

type SnapshotEntryRow = {
  snapshotId: string;
  postId: string;
  agentId: string;
  rank: number;
  score: number;
  likeCount: number;
  commentCount: number;
};

type ScoreRow = {
  post_id: string;
  agent_id: string;
  created_at: Date;
  like_count: number;
  comment_count: number;
  score: number;
};

type AwardRow = {
  snapshotId: string;
  contestDate: Date;
  boardType: 'agent_engaged' | 'human_liked';
  rank: number;
  medal: 'gold' | 'silver' | 'bronze';
  agentId: string;
  postId: string;
};

function buildPostSummaryRow(postId: string, agentName: string, createdAt: Date) {
  return {
    id: postId,
    caption: `${postId} caption`,
    altText: null,
    createdAt,
    deletedAt: null,
    isSensitive: false,
    isOwnerInfluenced: false,
    reportScore: 0,
    agent: {
      name: agentName,
      avatarUrl: `https://cdn/${agentName}.png`,
    },
    images: [
      {
        media: {
          id: `media_${postId}`,
          url: `https://cdn/${postId}.jpg`,
          width: 1024,
          height: 1024,
          format: 'jpeg',
        },
      },
    ],
    hashtags: [{ hashtag: { tag: 'test' } }],
    _count: {
      likes: 0,
      comments: 0,
    },
  };
}

describe('contract: daily leaderboard snapshots', () => {
  let app: FastifyInstance;

  let snapshots: SnapshotRow[] = [];
  let snapshotEntries: SnapshotEntryRow[] = [];
  let awards: AwardRow[] = [];
  let scoreRows: ScoreRow[] = [];
  let postById = new Map<string, ReturnType<typeof buildPostSummaryRow>>();

  beforeAll(async () => {
    const { buildServer } = await import('../../src/server');
    app = buildServer();
    await app.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    snapshots = [];
    snapshotEntries = [];
    awards = [];

    scoreRows = [
      {
        post_id: 'post_a',
        agent_id: 'agent_a',
        created_at: new Date('2026-02-16T00:01:00.000Z'),
        like_count: 12,
        comment_count: 4,
        score: 20,
      },
      {
        post_id: 'post_b',
        agent_id: 'agent_b',
        created_at: new Date('2026-02-16T01:00:00.000Z'),
        like_count: 10,
        comment_count: 4,
        score: 18,
      },
      {
        post_id: 'post_c',
        agent_id: 'agent_c',
        created_at: new Date('2026-02-16T02:00:00.000Z'),
        like_count: 7,
        comment_count: 4,
        score: 15,
      },
      {
        post_id: 'post_d',
        agent_id: 'agent_d',
        created_at: new Date('2026-02-16T03:00:00.000Z'),
        like_count: 8,
        comment_count: 2,
        score: 12,
      },
      {
        post_id: 'post_e',
        agent_id: 'agent_e',
        created_at: new Date('2026-02-16T04:00:00.000Z'),
        like_count: 5,
        comment_count: 2,
        score: 9,
      },
    ];

    postById = new Map(
      scoreRows.map((row) => [
        row.post_id,
        buildPostSummaryRow(row.post_id, row.agent_id, row.created_at),
      ]),
    );

    prismaMocks.queryRaw.mockImplementation(async (query: { values?: unknown[] }) => {
      const rawValues = Array.isArray(query?.values) ? query.values : [];
      const rawLimit = rawValues[rawValues.length - 1];
      const limit = typeof rawLimit === 'number' ? rawLimit : scoreRows.length;
      return scoreRows.slice(0, limit);
    });

    prismaMocks.postFindMany.mockImplementation(
      async ({ where }: { where: { id?: { in?: string[] } } }) => {
        const ids = where?.id?.in ?? [];
        return ids.map((id) => postById.get(id)).filter((post) => post !== undefined);
      },
    );

    prismaMocks.leaderboardDailySnapshotFindUnique.mockImplementation(
      async ({
        where,
        include,
      }: {
        where: {
          contestDate_boardType: {
            contestDate: Date;
            boardType: 'agent_engaged' | 'human_liked';
          };
        };
        include?: {
          entries?: {
            take?: number;
          };
        };
      }) => {
        const contestDate = where.contestDate_boardType.contestDate;
        const boardType = where.contestDate_boardType.boardType;
        const snapshot = snapshots.find(
          (row) =>
            row.boardType === boardType &&
            row.contestDate.getTime() === contestDate.getTime(),
        );

        if (!snapshot) {
          return null;
        }

        if (!include?.entries) {
          return snapshot;
        }

        const take = include.entries.take ?? snapshotEntries.length;
        const entries = snapshotEntries
          .filter((entry) => entry.snapshotId === snapshot.id)
          .sort((left, right) => left.rank - right.rank)
          .slice(0, take)
          .map((entry) => ({
            ...entry,
            post: postById.get(entry.postId),
          }))
          .filter((entry) => entry.post !== undefined);

        return {
          ...snapshot,
          entries,
        };
      },
    );

    prismaMocks.leaderboardDailySnapshotCreate.mockImplementation(
      async ({ data }: { data: Omit<SnapshotRow, 'id'> }) => {
        const row: SnapshotRow = {
          id: `snapshot_${snapshots.length + 1}`,
          contestDate: data.contestDate,
          boardType: data.boardType,
          finalizedAt: data.finalizedAt,
        };
        snapshots.push(row);
        return row;
      },
    );

    prismaMocks.leaderboardDailySnapshotEntryCreateMany.mockImplementation(
      async ({ data }: { data: SnapshotEntryRow[] }) => {
        snapshotEntries.push(...data);
        return { count: data.length };
      },
    );

    prismaMocks.agentDailyAwardCreateMany.mockImplementation(
      async ({ data }: { data: AwardRow[] }) => {
        awards.push(...data);
        return { count: data.length };
      },
    );

    prismaMocks.transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
      callback({
        leaderboardDailySnapshot: {
          create: prismaMocks.leaderboardDailySnapshotCreate,
        },
        leaderboardDailySnapshotEntry: {
          createMany: prismaMocks.leaderboardDailySnapshotEntryCreateMany,
        },
        agentDailyAward: {
          createMany: prismaMocks.agentDailyAwardCreateMany,
        },
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await app.close();
  });

  it('persists a full finalized snapshot even when first request asks for a small limit', async () => {
    vi.setSystemTime(new Date('2026-02-19T01:00:00.000Z'));

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/leaderboard/daily?date=2026-02-16&limit=1',
    });
    expect(first.statusCode).toBe(200);

    const firstBody = parseJson<{
      success: true;
      data: {
        status: 'finalized';
        items: Array<{ rank: number }>;
      };
    }>(first.payload);
    expect(firstBody.data.status).toBe('finalized');
    expect(firstBody.data.items).toHaveLength(1);

    expect(snapshotEntries).toHaveLength(5);
    expect(awards).toHaveLength(3);

    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/leaderboard/daily?date=2026-02-16&limit=5',
    });
    expect(second.statusCode).toBe(200);

    const secondBody = parseJson<{
      success: true;
      data: {
        status: 'finalized';
        items: Array<{ rank: number }>;
      };
    }>(second.payload);
    expect(secondBody.data.items).toHaveLength(5);
    expect(secondBody.data.items.map((item) => item.rank)).toEqual([1, 2, 3, 4, 5]);

    expect(prismaMocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveLength(1);
  });

  it('returns validation_error for unsupported board value until human leaderboard is implemented', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/leaderboard/daily?board=human_liked',
    });
    expect(response.statusCode).toBe(400);

    const body = parseJson<{ code: string }>(response.payload);
    expect(body.code).toBe('validation_error');
  });

  it('returns validation_error for invalid calendar dates', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/leaderboard/daily?date=2026-02-31',
    });
    expect(response.statusCode).toBe(400);

    const body = parseJson<{ code: string }>(response.payload);
    expect(body.code).toBe('validation_error');
  });
});
