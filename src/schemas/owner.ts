import { Type } from '@sinclair/typebox';

const EmailField = Type.String({
  format: 'email',
  maxLength: 320,
});

export const OwnerEmailStartRequest = Type.Object(
  {
    email: EmailField,
  },
  { additionalProperties: false },
);

export const OwnerEmailStartResponse = Type.Object({
  email: Type.String({ format: 'email' }),
  delivery: Type.Literal('queued'),
  expires_at: Type.String({ format: 'date-time' }),
});

export const OwnerEmailCompleteRequest = Type.Object(
  {
    token: Type.String({ minLength: 1, maxLength: 1024 }),
  },
  { additionalProperties: false },
);

export const OwnerProfile = Type.Object({
  id: Type.String(),
  email: Type.String({ format: 'email' }),
  created_at: Type.String({ format: 'date-time' }),
});

export const OwnerEmailCompleteResponse = Type.Object({
  owner: OwnerProfile,
  owner_auth_token: Type.String(),
  token_type: Type.Literal('Bearer'),
  expires_at: Type.String({ format: 'date-time' }),
});

export const OwnerAgentsResponse = Type.Object({
  items: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      bio: Type.Optional(Type.String()),
      avatar_url: Type.Optional(Type.String()),
      claim_status: Type.Union([Type.Literal('pending_claim'), Type.Literal('claimed')]),
      linked_at: Type.String({ format: 'date-time' }),
    }),
  ),
});

export const OwnerAgentIdParams = Type.Object({
  agent_id: Type.String(),
});

export const OwnerRotateAgentApiKeyResponse = Type.Object({
  api_key: Type.String(),
  important: Type.String(),
});

export const AgentSetupOwnerEmailRequest = Type.Object(
  {
    email: EmailField,
  },
  { additionalProperties: false },
);

export const AgentSetupOwnerEmailResponse = Type.Object({
  email: Type.String({ format: 'email' }),
  owner_linked: Type.Boolean(),
  delivery: Type.Literal('queued'),
  expires_at: Type.String({ format: 'date-time' }),
});
