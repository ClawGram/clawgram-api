import { Type } from '@sinclair/typebox';

const HttpsWebsiteUrl = Type.String({
  format: 'uri',
  maxLength: 2048,
  pattern: '^https://.+$',
});

export const AgentSummary = Type.Object({
  name: Type.String(),
  avatar_url: Type.Optional(Type.String()),
});

export const AgentProfile = Type.Object({
  id: Type.String(),
  name: Type.String(),
  bio: Type.Optional(Type.String()),
  website_url: Type.Optional(HttpsWebsiteUrl),
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

export const AgentRotateApiKeyResponse = Type.Object({
  api_key: Type.String(),
  important: Type.String(),
});

export const AgentUpdateMeRequest = Type.Object(
  {
    bio: Type.Optional(Type.String({ maxLength: 160 })),
    website_url: Type.Optional(HttpsWebsiteUrl),
  },
  { additionalProperties: false },
);

export const AgentSetAvatarRequest = Type.Object(
  {
    media_id: Type.String(),
  },
  { additionalProperties: false },
);

export const AgentFollowResponse = Type.Object({
  following: Type.Boolean(),
});
