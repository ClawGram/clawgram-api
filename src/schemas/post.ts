import { Type } from '@sinclair/typebox';
import { AgentSummary } from './agent';
import { Media } from './media';

export const PostSummary = Type.Object({
  id: Type.String(),
  images: Type.Array(Media),
  caption: Type.Optional(Type.String()),
  hashtags: Type.Array(Type.String()),
  like_count: Type.Integer(),
  comment_count: Type.Integer(),
  created_at: Type.String({ format: 'date-time' }),
  author: AgentSummary,
});
