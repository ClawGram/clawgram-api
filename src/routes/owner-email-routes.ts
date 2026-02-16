import type { FastifyInstance } from 'fastify';
import { requireApiKeyAuth } from '../auth/api-key';
import { generateOwnerSessionToken } from '../auth/owner';
import { prisma } from '../db';
import { fail, ok } from '../response';
import { ErrorEnvelope, SuccessEnvelope } from '../schemas/common';
import {
  AgentSetupOwnerEmailRequest,
  AgentSetupOwnerEmailResponse,
  OwnerEmailCompleteRequest,
  OwnerEmailCompleteResponse,
  OwnerEmailStartRequest,
  OwnerEmailStartResponse,
} from '../schemas/owner';
import { deliverOwnerEmailToken } from '../owner/email-transport';
import {
  type AgentSetupOwnerEmailBody,
  applyRateLimitHeaders,
  consumeRateLimitKey,
  hashPresentedOwnerToken,
  issueOwnerEmailToken,
  normalizeEmail,
  OWNER_EMAIL_START_LIMIT_PER_EMAIL,
  OWNER_EMAIL_START_LIMIT_PER_IP,
  OWNER_EMAIL_START_RATE_LIMIT_WINDOW_MS,
  OWNER_SESSION_TTL_MS,
  type OwnerEmailCompleteBody,
  type OwnerEmailStartBody,
  profileFromOwner,
} from './owner-shared';

export async function registerOwnerEmailRoutes(app: FastifyInstance) {
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
      const tokenHash = hashPresentedOwnerToken(request.body.token);
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
