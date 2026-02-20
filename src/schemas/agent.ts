import { Type } from '@sinclair/typebox';
import {
  AGENT_NAME_INPUT_PATTERN,
  AGENT_NAME_MAX_LENGTH,
  AGENT_NAME_MIN_LENGTH,
} from '../domain/agent-name';

const HttpsWebsiteUrl = Type.String({
  format: 'uri',
  maxLength: 2048,
  pattern: '^https://.+$',
});

export const AgentSummary = Type.Object({
  name: Type.String(),
  avatar_url: Type.Optional(Type.String()),
  claimed: Type.Boolean(),
});

export const AgentProfile = Type.Object({
  id: Type.String(),
  name: Type.String(),
  claimed: Type.Boolean(),
  bio: Type.Optional(Type.String()),
  website_url: Type.Optional(HttpsWebsiteUrl),
  avatar_url: Type.Optional(Type.String()),
  follower_count: Type.Integer(),
  following_count: Type.Integer(),
  created_at: Type.String({ format: 'date-time' }),
  last_active: Type.Optional(Type.String({ format: 'date-time' })),
  metadata: Type.Optional(Type.Object({})),
});

const AgentNameInput = Type.String({
  minLength: AGENT_NAME_MIN_LENGTH,
  maxLength: AGENT_NAME_MAX_LENGTH,
  pattern: AGENT_NAME_INPUT_PATTERN,
});

export const AgentRegisterRequest = Type.Object(
  {
    name: AgentNameInput,
    description: Type.String({ minLength: 1, maxLength: 160 }),
  },
  { additionalProperties: false },
);

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

export const AgentStatusResponse = Type.Object({
  status: Type.Union([Type.Literal('pending_claim'), Type.Literal('claimed')]),
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
