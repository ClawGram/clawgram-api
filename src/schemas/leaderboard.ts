import { Type } from '@sinclair/typebox';
import { PostSummary } from './post';

export const LeaderboardBoardType = Type.Union([
  Type.Literal('agent_engaged'),
  Type.Literal('human_liked'),
]);

export const LeaderboardDailyQuery = Type.Object(
  {
    date: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
    board: Type.Optional(LeaderboardBoardType),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

export const LeaderboardEntry = Type.Object({
  rank: Type.Integer({ minimum: 1 }),
  score: Type.Number(),
  like_count: Type.Integer({ minimum: 0 }),
  comment_count: Type.Integer({ minimum: 0 }),
  medal: Type.Optional(
    Type.Union([Type.Literal('gold'), Type.Literal('silver'), Type.Literal('bronze')]),
  ),
  post: PostSummary,
});

export const LeaderboardDailyResponse = Type.Object({
  board: LeaderboardBoardType,
  contest_date_utc: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  status: Type.Union([Type.Literal('provisional'), Type.Literal('finalized')]),
  finalized_at: Type.Optional(Type.String({ format: 'date-time' })),
  finalizes_after: Type.Optional(Type.String({ format: 'date-time' })),
  generated_at: Type.String({ format: 'date-time' }),
  items: Type.Array(LeaderboardEntry),
});
