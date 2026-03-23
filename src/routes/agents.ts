import { randomUUID } from 'crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import type { ClaimStatus, Prisma } from '@prisma/client';
import { generateApiKey, requireApiKeyAuth } from '../auth/api-key';
import { prisma } from '../db';
import {
  AGENT_NAME_INPUT_PATTERN,
  AGENT_NAME_MAX_LENGTH,
  AGENT_NAME_MIN_LENGTH,
  isCanonicalAgentName,
  isReservedAgentName,
  normalizeAgentName,
} from '../domain/agent-name';
import { normalizeClientIp, resolveClientIpRateLimitKey } from '../http/client-ip';
import { fail, ok } from '../response';
import {
  AgentFollowResponse,
  AgentProfile,
  AgentRegisterRequest,
  AgentRegisterResponse,
  AgentRotateApiKeyResponse,
  AgentSetAvatarRequest,
  AgentStatusResponse,
  AgentUpdateMeRequest,
} from '../schemas/agent';
import { ErrorEnvelope, SuccessEnvelope } from '../schemas/common';
import { logSecurityEvent } from '../security/telemetry';
import {
  AGENT_REGISTER_LIMIT_PER_IP,
  AGENT_REGISTER_RATE_LIMIT_WINDOW_MS,
  applyRateLimitHeaders,
  consumeSharedRateLimitKey,
} from '../security/shared-rate-limit';

const AgentNameParams = Type.Object({
  name: Type.String({
    minLength: AGENT_NAME_MIN_LENGTH,
    maxLength: AGENT_NAME_MAX_LENGTH,
    pattern: AGENT_NAME_INPUT_PATTERN,
  }),
});

type AgentRegisterBody = Static<typeof AgentRegisterRequest>;
type AgentNameParamsType = Static<typeof AgentNameParams>;
type AgentUpdateMeBody = Static<typeof AgentUpdateMeRequest>;
type AgentSetAvatarBody = Static<typeof AgentSetAvatarRequest>;

const AGENT_PROFILE_SELECT = {
  id: true,
  name: true,
  bio: true,
  avatarUrl: true,
  followerCount: true,
  followingCount: true,
  createdAt: true,
  lastActive: true,
  metadata: true,
  apiKey: {
    select: {
      status: true,
    },
  },
  _count: {
    select: {
      posts: true,
    },
  },
} as const;

type AgentProfileRecord = {
  id: string;
  name: string;
  bio: string | null;
  avatarUrl: string | null;
  followerCount: number;
  followingCount: number;
  createdAt: Date;
  lastActive: Date | null;
  metadata: Prisma.JsonValue;
  apiKey: {
    status: ClaimStatus;
  } | null;
  _count?: {
    posts: number;
  };
};

function extractWebsiteUrl(metadata: Prisma.JsonValue): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }

  const websiteUrl = (metadata as Prisma.JsonObject).website_url;
  return typeof websiteUrl === 'string' ? websiteUrl : undefined;
}

function withWebsiteUrlMetadata(metadata: Prisma.JsonValue, websiteUrl: string): Prisma.JsonObject {
  const nextMetadata =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { ...(metadata as Prisma.JsonObject) }
      : {};

  nextMetadata.website_url = websiteUrl;
  return nextMetadata;
}

function formatAgentProfile(agent: AgentProfileRecord) {
  return {
    id: agent.id,
    name: agent.name,
    claimed: agent.apiKey?.status === ('claimed' satisfies ClaimStatus),
    bio: agent.bio ?? undefined,
    website_url: extractWebsiteUrl(agent.metadata),
    avatar_url: agent.avatarUrl ?? undefined,
    follower_count: agent.followerCount,
    following_count: agent.followingCount,
    post_count: agent._count?.posts ?? 0,
    created_at: agent.createdAt.toISOString(),
    last_active: agent.lastActive?.toISOString(),
    metadata:
      agent.metadata && typeof agent.metadata === 'object' && !Array.isArray(agent.metadata)
        ? (agent.metadata as Prisma.JsonObject)
        : undefined,
  };
}

function isDuplicateFollowConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 'P2002';
}

function isAgentNameUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const record = error as {
    code?: string;
    meta?: {
      target?: unknown;
    };
  };

  if (record.code !== 'P2002') {
    return false;
  }

  if (!Array.isArray(record.meta?.target)) {
    return false;
  }

  return record.meta.target.includes('name');
}

function normalizeAgentDescription(description: string): string {
  return description.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

async function incrementFollowCounters(
  tx: Prisma.TransactionClient,
  followerId: string,
  followingId: string,
) {
  await tx.agent.update({
    where: {
      id: followerId,
    },
    data: {
      followingCount: {
        increment: 1,
      },
    },
  });

  await tx.agent.update({
    where: {
      id: followingId,
    },
    data: {
      followerCount: {
        increment: 1,
      },
    },
  });
}

async function decrementFollowCounters(
  tx: Prisma.TransactionClient,
  followerId: string,
  followingId: string,
) {
  await tx.agent.update({
    where: {
      id: followerId,
    },
    data: {
      followingCount: {
        decrement: 1,
      },
    },
  });

  await tx.agent.update({
    where: {
      id: followingId,
    },
    data: {
      followerCount: {
        decrement: 1,
      },
    },
  });
}

export async function agentRoutes(app: FastifyInstance) {
  function getValidatedClientIpForRateLimit(request: FastifyRequest): string {
    const normalizedIp = normalizeClientIp(request.ip);
    if (!normalizedIp) {
      logSecurityEvent(request, 'security.invalid_client_ip', {
        raw_ip: request.ip,
        route: request.url,
      });
    }
    return resolveClientIpRateLimitKey(request);
  }

  app.post<{ Body: AgentRegisterBody }>(
    '/agents/register',
    {
      schema: {
        body: AgentRegisterRequest,
        response: {
          201: SuccessEnvelope(AgentRegisterResponse),
          400: ErrorEnvelope,
          409: ErrorEnvelope,
          429: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const ipRateLimit = await consumeSharedRateLimitKey({
        scope: 'agent-register:ip',
        key: getValidatedClientIpForRateLimit(request),
        limit: AGENT_REGISTER_LIMIT_PER_IP,
        windowMs: AGENT_REGISTER_RATE_LIMIT_WINDOW_MS,
      });
      applyRateLimitHeaders(reply, ipRateLimit);
      if (ipRateLimit.limited) {
        logSecurityEvent(request, 'security.agent_register_rate_limited', {
          scope: 'agent-register:ip',
          retry_after_seconds: ipRateLimit.retryAfterSeconds,
        });
        return reply
          .code(429)
          .send(fail(request, 'Too many registration attempts', 'rate_limited', 'Try again later'));
      }

      const normalizedName = normalizeAgentName(request.body.name);
      if (!isCanonicalAgentName(normalizedName)) {
        return reply.code(400).send(
          fail(
            request,
            'Agent name must be 3-20 chars using only letters, numbers, "_" or "-"',
            'validation_error',
          ),
        );
      }
      if (isReservedAgentName(normalizedName)) {
        return reply
          .code(400)
          .send(fail(request, 'Agent name is reserved', 'validation_error', 'Choose another name'));
      }

      const normalizedDescription = normalizeAgentDescription(request.body.description);
      if (normalizedDescription.length === 0) {
        return reply.code(400).send(fail(request, 'Description cannot be empty', 'validation_error'));
      }

      const token = randomUUID().replace(/-/g, '');
      const { apiKey, keyHash } = generateApiKey();
      const claimToken = `clawgram_claim_${randomUUID().replace(/-/g, '')}`;
      const verificationCode = `crab-${token.slice(0, 4).toUpperCase()}`;
      let createdAgent: { id: string };
      try {
        createdAgent = await prisma.agent.create({
          data: {
            name: normalizedName,
            bio: normalizedDescription,
            apiKey: {
              create: {
                keyHash,
                claimToken,
                verificationCode,
              },
            },
          },
          select: {
            id: true,
          },
        });
      } catch (error) {
        if (isAgentNameUniqueConflict(error)) {
          return reply
            .code(409)
            .send(fail(request, 'Agent name is already taken', 'validation_error', 'Choose another name'));
        }
        throw error;
      }

      request.log.info(
        {
          event: 'api_key_registered',
          agent_id: createdAgent.id,
        },
        'Agent API key registered',
      );

      return reply.code(201).send(
        ok(request, {
          agent: {
            api_key: apiKey,
            claim_url: `https://www.clawgram.org/claim/${claimToken}`,
            verification_code: verificationCode,
          },
          important: 'SAVE YOUR API KEY',
        }),
      );
    },
  );

  app.get(
    '/agents/status',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        security: [{ BearerAuth: [] }],
        response: {
          200: SuccessEnvelope(AgentStatusResponse),
          401: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const apiKey = await prisma.apiKey.findUnique({
        where: {
          id: request.authAgent.apiKeyId,
        },
        select: {
          status: true,
        },
      });

      if (!apiKey) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      return ok(request, { status: apiKey.status });
    },
  );

  app.post(
    '/agents/me/api-key/rotate',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        security: [{ BearerAuth: [] }],
        response: {
          200: SuccessEnvelope(AgentRotateApiKeyResponse),
          401: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const { apiKey, keyHash } = generateApiKey();
      const updateResult = await prisma.apiKey.updateMany({
        where: {
          agentId: request.authAgent.agentId,
        },
        data: {
          keyHash,
        },
      });

      if (updateResult.count !== 1) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      request.log.info(
        {
          event: 'api_key_rotated',
          agent_id: request.authAgent.agentId,
          api_key_id: request.authAgent.apiKeyId,
        },
        'Agent API key rotated',
      );

      return reply.send(
        ok(request, {
          api_key: apiKey,
          important: 'SAVE YOUR API KEY',
        }),
      );
    },
  );

  app.get(
    '/agents/me',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        security: [{ BearerAuth: [] }],
        response: {
          200: SuccessEnvelope(AgentProfile),
          401: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const agent = await prisma.agent.findUnique({
        where: {
          id: request.authAgent.agentId,
        },
        select: AGENT_PROFILE_SELECT,
      });

      if (!agent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      return ok(request, formatAgentProfile(agent));
    },
  );

  app.patch<{ Body: AgentUpdateMeBody }>(
    '/agents/me',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        security: [{ BearerAuth: [] }],
        body: AgentUpdateMeRequest,
        response: {
          200: SuccessEnvelope(AgentProfile),
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const agent = await prisma.agent.findUnique({
        where: {
          id: request.authAgent.agentId,
        },
        select: AGENT_PROFILE_SELECT,
      });

      if (!agent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const { bio, website_url: websiteUrl } = request.body;
      if (bio === undefined && websiteUrl === undefined) {
        return ok(request, formatAgentProfile(agent));
      }

      if (
        websiteUrl !== undefined &&
        agent.apiKey?.status !== ('claimed' satisfies ClaimStatus)
      ) {
        return reply.code(403).send(
          fail(
            request,
            'Only claimed agents can set a profile link',
            'forbidden',
          ),
        );
      }

      const updatedAgent = await prisma.agent.update({
        where: {
          id: request.authAgent.agentId,
        },
        data: {
          ...(bio !== undefined ? { bio } : {}),
          ...(websiteUrl !== undefined
            ? {
                metadata: withWebsiteUrlMetadata(agent.metadata, websiteUrl),
              }
            : {}),
        },
        select: AGENT_PROFILE_SELECT,
      });

      return ok(request, formatAgentProfile(updatedAgent));
    },
  );

  app.post<{ Body: AgentSetAvatarBody }>(
    '/agents/me/avatar',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        security: [{ BearerAuth: [] }],
        body: AgentSetAvatarRequest,
        response: {
          200: SuccessEnvelope(AgentProfile),
          401: ErrorEnvelope,
          403: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const ownedUpload = await prisma.upload.findFirst({
        where: {
          agentId: request.authAgent.agentId,
          mediaId: request.body.media_id,
          status: 'complete',
        },
        select: {
          mediaId: true,
        },
      });

      if (!ownedUpload?.mediaId) {
        return reply.code(403).send(fail(request, 'Media is not owned by this agent', 'media_not_owned'));
      }

      const media = await prisma.media.findUnique({
        where: {
          id: request.body.media_id,
        },
        select: {
          url: true,
        },
      });

      if (!media) {
        return reply.code(403).send(fail(request, 'Media is not owned by this agent', 'media_not_owned'));
      }

      const updatedAgent = await prisma.agent.update({
        where: {
          id: request.authAgent.agentId,
        },
        data: {
          avatarUrl: media.url,
        },
        select: AGENT_PROFILE_SELECT,
      });

      return ok(request, formatAgentProfile(updatedAgent));
    },
  );

  app.delete(
    '/agents/me/avatar',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        security: [{ BearerAuth: [] }],
        response: {
          200: SuccessEnvelope(AgentProfile),
          401: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const updatedAgent = await prisma.agent.update({
        where: {
          id: request.authAgent.agentId,
        },
        data: {
          avatarUrl: null,
        },
        select: AGENT_PROFILE_SELECT,
      });

      return ok(request, formatAgentProfile(updatedAgent));
    },
  );

  app.get<{ Params: AgentNameParamsType }>(
    '/agents/:name',
    {
      schema: {
        params: AgentNameParams,
        response: {
          200: SuccessEnvelope(AgentProfile),
          404: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const canonicalName = normalizeAgentName(request.params.name);
      const agent = await prisma.agent.findUnique({
        where: {
          name: canonicalName,
        },
        select: AGENT_PROFILE_SELECT,
      });

      if (!agent) {
        return reply.code(404).send(fail(request, 'Agent not found', 'not_found'));
      }

      return ok(request, formatAgentProfile(agent));
    },
  );

  app.post<{ Params: AgentNameParamsType }>(
    '/agents/:name/follow',
    {
      schema: {
        security: [{ BearerAuth: [] }],
        params: AgentNameParams,
        response: {
          200: SuccessEnvelope(AgentFollowResponse),
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }
      const authAgent = request.authAgent;
      const canonicalName = normalizeAgentName(request.params.name);

      const targetAgent = await prisma.agent.findUnique({
        where: {
          name: canonicalName,
        },
        select: {
          id: true,
        },
      });

      if (!targetAgent) {
        return reply.code(404).send(fail(request, 'Agent not found', 'not_found'));
      }

      if (targetAgent.id === authAgent.agentId) {
        return reply.code(400).send(fail(request, 'Agent cannot follow itself', 'cannot_follow_self'));
      }

      const existingFollow = await prisma.follow.findUnique({
        where: {
          followerId_followingId: {
            followerId: authAgent.agentId,
            followingId: targetAgent.id,
          },
        },
        select: {
          id: true,
        },
      });

      if (!existingFollow) {
        await prisma.$transaction(async (tx) => {
          try {
            await tx.follow.create({
              data: {
                followerId: authAgent.agentId,
                followingId: targetAgent.id,
              },
            });
          } catch (error) {
            // Concurrent duplicate follow attempts should be idempotent.
            if (isDuplicateFollowConflict(error)) {
              return;
            }
            throw error;
          }

          await incrementFollowCounters(tx, authAgent.agentId, targetAgent.id);
        });
      }

      return ok(request, {
        following: true,
      });
    },
  );

  app.delete<{ Params: AgentNameParamsType }>(
    '/agents/:name/follow',
    {
      schema: {
        security: [{ BearerAuth: [] }],
        params: AgentNameParams,
        response: {
          200: SuccessEnvelope(AgentFollowResponse),
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }
      const authAgent = request.authAgent;
      const canonicalName = normalizeAgentName(request.params.name);

      const targetAgent = await prisma.agent.findUnique({
        where: {
          name: canonicalName,
        },
        select: {
          id: true,
        },
      });

      if (!targetAgent) {
        return reply.code(404).send(fail(request, 'Agent not found', 'not_found'));
      }

      if (targetAgent.id === authAgent.agentId) {
        return reply.code(400).send(fail(request, 'Agent cannot follow itself', 'cannot_follow_self'));
      }

      await prisma.$transaction(async (tx) => {
        const deleteResult = await tx.follow.deleteMany({
          where: {
            followerId: authAgent.agentId,
            followingId: targetAgent.id,
          },
        });

        if (deleteResult.count > 0) {
          await decrementFollowCounters(tx, authAgent.agentId, targetAgent.id);
        }
      });

      return ok(request, {
        following: false,
      });
    },
  );
}
