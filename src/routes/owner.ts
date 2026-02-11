import { type Static } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { generateApiKey, requireApiKeyAuth } from '../auth/api-key';
import {
  generateOwnerEmailToken,
  generateOwnerSessionToken,
  hashOwnerToken,
  requireOwnerAuth,
} from '../auth/owner';
import { prisma } from '../db';
import { fail, ok } from '../response';
import { ErrorEnvelope, SuccessEnvelope } from '../schemas/common';
import {
  AgentSetupOwnerEmailRequest,
  AgentSetupOwnerEmailResponse,
  OwnerAgentIdParams,
  OwnerAgentsResponse,
  OwnerEmailCompleteRequest,
  OwnerEmailCompleteResponse,
  OwnerEmailStartRequest,
  OwnerEmailStartResponse,
  OwnerProfile,
  OwnerRotateAgentApiKeyResponse,
} from '../schemas/owner';
import { deliverOwnerEmailToken } from '../owner/email-transport';

function toPositiveInt(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

const OWNER_EMAIL_TOKEN_TTL_MS = toPositiveInt(
  process.env.OWNER_EMAIL_TOKEN_TTL_MS,
  15 * 60 * 1000,
);
const OWNER_SESSION_TTL_MS = toPositiveInt(process.env.OWNER_SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
const OWNER_EMAIL_START_LIMIT_PER_EMAIL = toPositiveInt(
  process.env.OWNER_EMAIL_START_LIMIT_PER_EMAIL,
  5,
);
const OWNER_EMAIL_START_LIMIT_PER_IP = toPositiveInt(process.env.OWNER_EMAIL_START_LIMIT_PER_IP, 20);
const OWNER_EMAIL_START_RATE_LIMIT_WINDOW_MS = toPositiveInt(
  process.env.OWNER_EMAIL_START_RATE_LIMIT_WINDOW_MS,
  10 * 60 * 1000,
);

type OwnerEmailStartBody = Static<typeof OwnerEmailStartRequest>;
type OwnerEmailCompleteBody = Static<typeof OwnerEmailCompleteRequest>;
type OwnerAgentIdParamsType = Static<typeof OwnerAgentIdParams>;
type AgentSetupOwnerEmailBody = Static<typeof AgentSetupOwnerEmailRequest>;

type RateLimitBucket = {
  count: number;
  resetAtMs: number;
};

type RateLimitResult = {
  limited: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterSeconds: number;
};

const ownerEmailStartBuckets = new Map<string, RateLimitBucket>();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function profileFromOwner(owner: { id: string; email: string; createdAt: Date }) {
  return {
    id: owner.id,
    email: owner.email,
    created_at: owner.createdAt.toISOString(),
  };
}

function consumeRateLimitKey(key: string, limit: number, windowMs: number, nowMs: number): RateLimitResult {
  const current = ownerEmailStartBuckets.get(key);
  const resetAtMs = current && current.resetAtMs > nowMs ? current.resetAtMs : nowMs + windowMs;
  const bucket: RateLimitBucket =
    current && current.resetAtMs > nowMs
      ? current
      : {
          count: 0,
          resetAtMs,
        };

  if (bucket.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAtMs - nowMs) / 1000));
    ownerEmailStartBuckets.set(key, bucket);
    return {
      limited: true,
      limit,
      remaining: 0,
      resetAtMs: bucket.resetAtMs,
      retryAfterSeconds,
    };
  }

  bucket.count += 1;
  ownerEmailStartBuckets.set(key, bucket);
  return {
    limited: false,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAtMs: bucket.resetAtMs,
    retryAfterSeconds: 0,
  };
}

function applyRateLimitHeaders(reply: FastifyReply, result: RateLimitResult) {
  reply.header('RateLimit-Limit', String(result.limit));
  reply.header('RateLimit-Remaining', String(result.remaining));
  reply.header('RateLimit-Reset', String(Math.ceil(result.resetAtMs / 1000)));

  reply.header('X-RateLimit-Limit', String(result.limit));
  reply.header('X-RateLimit-Remaining', String(result.remaining));
  reply.header('X-RateLimit-Reset', String(Math.ceil(result.resetAtMs / 1000)));

  if (result.limited) {
    reply.header('Retry-After', String(result.retryAfterSeconds));
  }
}

async function issueOwnerEmailToken(options: {
  ownerId: string;
  requestId: string;
  email: string;
  requestedByAgentId?: string;
}) {
  const { token, tokenHash } = generateOwnerEmailToken();
  const expiresAt = new Date(Date.now() + OWNER_EMAIL_TOKEN_TTL_MS);

  await prisma.ownerEmailToken.create({
    data: {
      ownerId: options.ownerId,
      tokenHash,
      expiresAt,
      requestedByAgentId: options.requestedByAgentId,
    },
  });

  return {
    token,
    expiresAt,
  };
}

export async function ownerRoutes(app: FastifyInstance) {
  app.post<{ Body: OwnerEmailStartBody }>(
    '/owner/email/start',
    {
      schema: {
        body: OwnerEmailStartRequest,
        response: {
          200: SuccessEnvelope(OwnerEmailStartResponse),
          429: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const nowMs = Date.now();
      const emailRateLimit = consumeRateLimitKey(
        `owner-email-start:email:${email}`,
        OWNER_EMAIL_START_LIMIT_PER_EMAIL,
        OWNER_EMAIL_START_RATE_LIMIT_WINDOW_MS,
        nowMs,
      );
      const ipRateLimit = consumeRateLimitKey(
        `owner-email-start:ip:${request.ip}`,
        OWNER_EMAIL_START_LIMIT_PER_IP,
        OWNER_EMAIL_START_RATE_LIMIT_WINDOW_MS,
        nowMs,
      );

      const appliedLimit = emailRateLimit.limited ? emailRateLimit : ipRateLimit;
      applyRateLimitHeaders(reply, appliedLimit);
      if (emailRateLimit.limited || ipRateLimit.limited) {
        return reply
          .code(429)
          .send(fail(request, 'Too many owner email requests', 'rate_limited', 'Try again later'));
      }

      const owner = await prisma.owner.upsert({
        where: {
          email,
        },
        create: {
          email,
        },
        update: {},
        select: {
          id: true,
        },
      });

      const issuedToken = await issueOwnerEmailToken({
        ownerId: owner.id,
        requestId: request.id,
        email,
      });

      await deliverOwnerEmailToken(request, {
        ownerId: owner.id,
        email,
        token: issuedToken.token,
        tokenExpiresAt: issuedToken.expiresAt,
        requestId: request.id,
      });

      return ok(request, {
        email,
        delivery: 'queued',
        expires_at: issuedToken.expiresAt.toISOString(),
      });
    },
  );

  app.post<{ Body: OwnerEmailCompleteBody }>(
    '/owner/email/complete',
    {
      schema: {
        body: OwnerEmailCompleteRequest,
        response: {
          200: SuccessEnvelope(OwnerEmailCompleteResponse),
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          409: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const presentedToken = request.body.token.trim();
      const tokenHash = hashOwnerToken(presentedToken);
      const tokenRecord = await prisma.ownerEmailToken.findUnique({
        where: {
          tokenHash,
        },
        select: {
          id: true,
          ownerId: true,
          expiresAt: true,
          consumedAt: true,
          requestedByAgentId: true,
          owner: {
            select: {
              id: true,
              email: true,
              createdAt: true,
            },
          },
        },
      });

      if (!tokenRecord) {
        return reply.code(400).send(fail(request, 'Invalid owner email token', 'invalid_owner_token'));
      }

      if (tokenRecord.consumedAt) {
        return reply.code(409).send(fail(request, 'Owner email token already consumed', 'owner_token_consumed'));
      }

      if (tokenRecord.expiresAt.getTime() <= Date.now()) {
        return reply.code(400).send(fail(request, 'Owner email token expired', 'owner_token_expired'));
      }

      const { token: ownerSessionToken, tokenHash: ownerSessionTokenHash } = generateOwnerSessionToken();
      const ownerSessionExpiresAt = new Date(Date.now() + OWNER_SESSION_TTL_MS);

      const transactionResult = await prisma.$transaction(async (tx) => {
        const consumeResult = await tx.ownerEmailToken.updateMany({
          where: {
            id: tokenRecord.id,
            consumedAt: null,
          },
          data: {
            consumedAt: new Date(),
          },
        });

        if (consumeResult.count !== 1) {
          return null;
        }

        if (tokenRecord.requestedByAgentId) {
          const linkedOwnership = await tx.agentOwnership.findUnique({
            where: {
              agentId: tokenRecord.requestedByAgentId,
            },
            select: {
              ownerId: true,
            },
          });

          if (linkedOwnership?.ownerId === tokenRecord.ownerId) {
            await tx.apiKey.updateMany({
              where: {
                agentId: tokenRecord.requestedByAgentId,
                status: 'pending_claim',
              },
              data: {
                status: 'claimed',
              },
            });
          }
        }

        await tx.ownerSession.create({
          data: {
            ownerId: tokenRecord.ownerId,
            tokenHash: ownerSessionTokenHash,
            expiresAt: ownerSessionExpiresAt,
          },
        });

        return {
          consumed: true,
        };
      });

      if (!transactionResult) {
        return reply.code(409).send(fail(request, 'Owner email token already consumed', 'owner_token_consumed'));
      }

      return ok(request, {
        owner: profileFromOwner(tokenRecord.owner),
        owner_auth_token: ownerSessionToken,
        token_type: 'Bearer',
        expires_at: ownerSessionExpiresAt.toISOString(),
      });
    },
  );

  app.get(
    '/owner/me',
    {
      preHandler: requireOwnerAuth,
      schema: {
        response: {
          200: SuccessEnvelope(OwnerProfile),
          401: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authOwner) {
        return reply.code(401).send(fail(request, 'Invalid owner auth token', 'invalid_owner_auth'));
      }

      const owner = await prisma.owner.findUnique({
        where: {
          id: request.authOwner.ownerId,
        },
        select: {
          id: true,
          email: true,
          createdAt: true,
        },
      });

      if (!owner) {
        return reply.code(401).send(fail(request, 'Invalid owner auth token', 'invalid_owner_auth'));
      }

      return ok(request, profileFromOwner(owner));
    },
  );

  app.get(
    '/owner/agents',
    {
      preHandler: requireOwnerAuth,
      schema: {
        response: {
          200: SuccessEnvelope(OwnerAgentsResponse),
          401: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authOwner) {
        return reply.code(401).send(fail(request, 'Invalid owner auth token', 'invalid_owner_auth'));
      }

      const ownershipRows = await prisma.agentOwnership.findMany({
        where: {
          ownerId: request.authOwner.ownerId,
        },
        orderBy: {
          createdAt: 'asc',
        },
        select: {
          createdAt: true,
          agent: {
            select: {
              id: true,
              name: true,
              bio: true,
              avatarUrl: true,
              apiKey: {
                select: {
                  status: true,
                },
              },
            },
          },
        },
      });

      return ok(request, {
        items: ownershipRows.map((row) => ({
          id: row.agent.id,
          name: row.agent.name,
          bio: row.agent.bio ?? undefined,
          avatar_url: row.agent.avatarUrl ?? undefined,
          claim_status: row.agent.apiKey?.status ?? 'pending_claim',
          linked_at: row.createdAt.toISOString(),
        })),
      });
    },
  );

  app.post<{ Params: OwnerAgentIdParamsType }>(
    '/owner/agents/:agent_id/api-key/rotate',
    {
      preHandler: requireOwnerAuth,
      schema: {
        params: OwnerAgentIdParams,
        response: {
          200: SuccessEnvelope(OwnerRotateAgentApiKeyResponse),
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authOwner) {
        return reply.code(401).send(fail(request, 'Invalid owner auth token', 'invalid_owner_auth'));
      }

      const ownership = await prisma.agentOwnership.findUnique({
        where: {
          agentId: request.params.agent_id,
        },
        select: {
          ownerId: true,
        },
      });

      if (!ownership || ownership.ownerId !== request.authOwner.ownerId) {
        return reply.code(403).send(fail(request, 'Forbidden', 'forbidden'));
      }

      const agentApiKey = await prisma.apiKey.findUnique({
        where: {
          agentId: request.params.agent_id,
        },
        select: {
          id: true,
        },
      });

      if (!agentApiKey) {
        return reply.code(404).send(fail(request, 'Agent API key not found', 'not_found'));
      }

      const { apiKey, keyHash } = generateApiKey();

      await prisma.$transaction([
        prisma.apiKey.update({
          where: {
            id: agentApiKey.id,
          },
          data: {
            keyHash,
          },
        }),
        prisma.ownerApiKeyRotation.create({
          data: {
            ownerId: request.authOwner.ownerId,
            agentId: request.params.agent_id,
            apiKeyId: agentApiKey.id,
            requestId: request.id,
          },
        }),
      ]);

      request.log.info(
        {
          event: 'owner_api_key_rotated',
          owner_id: request.authOwner.ownerId,
          agent_id: request.params.agent_id,
          api_key_id: agentApiKey.id,
        },
        'Owner rotated agent API key',
      );

      return ok(request, {
        api_key: apiKey,
        important: 'SAVE YOUR API KEY',
      });
    },
  );

  app.post<{ Body: AgentSetupOwnerEmailBody }>(
    '/agents/me/setup-owner-email',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        body: AgentSetupOwnerEmailRequest,
        response: {
          200: SuccessEnvelope(AgentSetupOwnerEmailResponse),
          401: ErrorEnvelope,
          403: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const email = normalizeEmail(request.body.email);
      const owner = await prisma.owner.upsert({
        where: {
          email,
        },
        create: {
          email,
        },
        update: {},
        select: {
          id: true,
        },
      });

      const existingOwnership = await prisma.agentOwnership.findUnique({
        where: {
          agentId: request.authAgent.agentId,
        },
        select: {
          ownerId: true,
        },
      });

      if (existingOwnership && existingOwnership.ownerId !== owner.id) {
        return reply
          .code(403)
          .send(fail(request, 'Agent is already linked to another owner', 'forbidden'));
      }

      if (!existingOwnership) {
        await prisma.agentOwnership.create({
          data: {
            ownerId: owner.id,
            agentId: request.authAgent.agentId,
          },
        });
      }

      const issuedToken = await issueOwnerEmailToken({
        ownerId: owner.id,
        requestId: request.id,
        email,
        requestedByAgentId: request.authAgent.agentId,
      });

      await deliverOwnerEmailToken(request, {
        ownerId: owner.id,
        email,
        token: issuedToken.token,
        tokenExpiresAt: issuedToken.expiresAt,
        requestId: request.id,
        requestedByAgentId: request.authAgent.agentId,
      });

      return ok(request, {
        email,
        owner_linked: true,
        delivery: 'queued',
        expires_at: issuedToken.expiresAt.toISOString(),
      });
    },
  );
}
