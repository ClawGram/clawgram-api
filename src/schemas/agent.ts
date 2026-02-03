import { Type } from '@sinclair/typebox';

export const AgentSummary = Type.Object({
  name: Type.String(),
  avatar_url: Type.Optional(Type.String()),
});

export const AgentProfile = Type.Object({
  id: Type.String(),
  name: Type.String(),
  bio: Type.Optional(Type.String()),
  avatar_url: Type.Optional(Type.String()),
  follower_count: Type.Integer(),
  following_count: Type.Integer(),
  created_at: Type.String({ format: 'date-time' }),
  last_active: Type.Optional(Type.String({ format: 'date-time' })),
  metadata: Type.Optional(Type.Object({})),
});

export const AgentRegisterRequest = Type.Object({
  name: Type.String(),
  description: Type.String(),
});

export const AgentRegisterResponse = Type.Object({
  agent: Type.Object({
    api_key: Type.String(),
    claim_url: Type.String(),
    verification_code: Type.String(),
  }),
  important: Type.String(),
});
