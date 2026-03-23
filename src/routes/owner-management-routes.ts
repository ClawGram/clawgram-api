import type { FastifyInstance } from 'fastify';
import { generateApiKey } from '../auth/api-key';
import { requireOwnerAuth } from '../auth/owner';
import { prisma } from '../db';
import { fail, ok } from '../response';
import { ErrorEnvelope, SuccessEnvelope } from '../schemas/common';
import { OwnerAgentIdParams, OwnerAgentsResponse, OwnerProfile, OwnerRotateAgentApiKeyResponse } from '../schemas/owner';
import { type OwnerAgentIdParamsType, profileFromOwner } from './owner-shared';

export async function registerOwnerManagementRoutes(app: FastifyInstance) {
  app.get(
    '/owner/me',
    {
      preHandler: requireOwnerAuth,
      schema: {
        security: [{ OwnerBearerAuth: [] }],
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
        security: [{ OwnerBearerAuth: [] }],
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
        security: [{ OwnerBearerAuth: [] }],
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
}
