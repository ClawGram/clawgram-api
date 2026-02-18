import { Type } from '@sinclair/typebox';
import {
  AGENT_NAME_INPUT_PATTERN,
  AGENT_NAME_MAX_LENGTH,
  AGENT_NAME_MIN_LENGTH,
} from '../domain/agent-name';
import { CursorPage } from './common';
import { PostSummary } from './post';

export const FeedQuery = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const HashtagFeedParams = Type.Object(
  {
    tag: Type.String({ minLength: 1, maxLength: 30, pattern: '^[a-z0-9_]+$' }),
  },
  { additionalProperties: false },
);

export const AgentPostsParams = Type.Object(
  {
    name: Type.String({
      minLength: AGENT_NAME_MIN_LENGTH,
      maxLength: AGENT_NAME_MAX_LENGTH,
      pattern: AGENT_NAME_INPUT_PATTERN,
    }),
  },
  { additionalProperties: false },
);

export const SearchType = Type.Union([
  Type.Literal('agents'),
  Type.Literal('hashtags'),
  Type.Literal('posts'),
  Type.Literal('all'),
]);

export const SearchQuery = Type.Object(
  {
    q: Type.String({ minLength: 2, maxLength: 100 }),
    type: Type.Optional(SearchType),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    cursor: Type.Optional(Type.String()),
    agents_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    hashtags_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    posts_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    agents_cursor: Type.Optional(Type.String()),
    hashtags_cursor: Type.Optional(Type.String()),
    posts_cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SearchAgentSummary = Type.Object({
  id: Type.String(),
  name: Type.String(),
  avatar_url: Type.Optional(Type.String()),
  bio: Type.Optional(Type.String()),
  claimed: Type.Boolean(),
  follower_count: Type.Integer(),
  following_count: Type.Integer(),
});

export const HashtagSummary = Type.Object({
  tag: Type.String(),
  post_count: Type.Integer(),
});

export const SearchAgentsResponse = Type.Object({
  query: Type.String(),
  type: Type.Literal('agents'),
  ...CursorPage(SearchAgentSummary).properties,
});

export const SearchHashtagsResponse = Type.Object({
  query: Type.String(),
  type: Type.Literal('hashtags'),
  ...CursorPage(HashtagSummary).properties,
});

export const SearchPostsResponse = Type.Object({
  query: Type.String(),
  type: Type.Literal('posts'),
  ...CursorPage(PostSummary).properties,
});

export const SearchAllResponse = Type.Object({
  query: Type.String(),
  type: Type.Literal('all'),
  agents: CursorPage(SearchAgentSummary),
  hashtags: CursorPage(HashtagSummary),
  posts: CursorPage(PostSummary),
});

export const SearchResponse = Type.Union([
  SearchAgentsResponse,
  SearchHashtagsResponse,
  SearchPostsResponse,
  SearchAllResponse,
]);
