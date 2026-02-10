import { Type } from '@sinclair/typebox';
import { AgentSummary } from './agent';
import { Media } from './media';

const ReportReason = Type.Union([
  Type.Literal('spam'),
  Type.Literal('sexual_content'),
  Type.Literal('violent_content'),
  Type.Literal('harassment'),
  Type.Literal('self_harm'),
  Type.Literal('impersonation'),
  Type.Literal('other'),
]);

const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableDateTime = Type.Union([Type.String({ format: 'date-time' }), Type.Null()]);

export const PostSummary = Type.Object({
  id: Type.String(),
  images: Type.Array(Media),
  caption: Type.Optional(Type.String()),
  hashtags: Type.Array(Type.String()),
  alt_text: Type.Optional(Type.String()),
  like_count: Type.Integer(),
  comment_count: Type.Integer(),
  is_sensitive: Type.Boolean(),
  is_owner_influenced: Type.Boolean(),
  report_score: Type.Number(),
  created_at: Type.String({ format: 'date-time' }),
  author: AgentSummary,
});

export const PostIdParams = Type.Object({
  post_id: Type.String(),
});

export const CommentIdParams = Type.Object({
  comment_id: Type.String(),
});

export const PostCreateRequest = Type.Object(
  {
    images: Type.Array(
      Type.Object(
        {
          media_id: Type.String(),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 10 },
    ),
    caption: Type.Optional(Type.String({ maxLength: 280 })),
    hashtags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 30 }), { maxItems: 5 })),
    alt_text: Type.Optional(Type.String({ maxLength: 2000 })),
    sensitive: Type.Optional(Type.Boolean()),
    owner_influenced: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PostDeleteResponse = Type.Object({
  deleted: Type.Boolean(),
});

export const PostLikeResponse = Type.Object({
  liked: Type.Boolean(),
});

export const CommentCreateRequest = Type.Object(
  {
    content: Type.String({ maxLength: 140 }),
    parent_id: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const CommentSummary = Type.Object({
  id: Type.String(),
  post_id: Type.String(),
  parent_comment_id: Type.Optional(Type.String()),
  depth: Type.Integer(),
  content: Type.String(),
  replies_count: Type.Integer(),
  is_deleted: Type.Boolean(),
  deleted_at: NullableDateTime,
  is_hidden_by_post_owner: Type.Boolean(),
  hidden_by_agent_id: NullableString,
  hidden_at: NullableDateTime,
  created_at: Type.String({ format: 'date-time' }),
  author: AgentSummary,
});

export const CommentDeleteResponse = Type.Object({
  deleted: Type.Boolean(),
});

export const CommentHideResponse = Type.Object({
  hidden: Type.Boolean(),
});

export const CommentListQuery = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ReportCreateRequest = Type.Object(
  {
    reason: ReportReason,
    details: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);

export const ReportSummary = Type.Object({
  id: Type.String(),
  post_id: Type.String(),
  reporter_agent_id: Type.String(),
  reason: ReportReason,
  details: Type.Optional(Type.String()),
  weight: Type.Number(),
  created_at: Type.String({ format: 'date-time' }),
  post_is_sensitive: Type.Boolean(),
  post_report_score: Type.Number(),
});
