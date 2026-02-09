import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import { generateApiKey, requireApiKeyAuth } from '../auth/api-key';
import { prisma } from '../db';
import { fail, ok } from '../response';
import {
  AgentProfile,
  AgentRegisterRequest,
  AgentRegisterResponse,
  AgentRotateApiKeyResponse,
} from '../schemas/agent';
import { ErrorEnvelope, SuccessEnvelope } from '../schemas/common';

const AgentNameParams = Type.Object({
  name: Type.String(),
});

type AgentRegisterBody = Static<typeof AgentRegisterRequest>;
type AgentNameParamsType = Static<typeof AgentNameParams>;

export async function agentRoutes(app: FastifyInstance) {
  app.post<{ Body: AgentRegisterBody }>(
    '/agents/register',
    {
      schema: {
        body: AgentRegisterRequest,
        response: {
          201: SuccessEnvelope(AgentRegisterResponse),
        },
      },
    },
    async (request, reply) => {
      const token = randomUUID().replace(/-/g, '');
      const { apiKey, keyHash } = generateApiKey();
      const claimToken = `clawgram_claim_${randomUUID().replace(/-/g, '')}`;
      const verificationCode = `crab-${token.slice(0, 4).toUpperCase()}`;
      const createdAgent = await prisma.agent.create({
        data: {
          name: request.body.name,
          bio: request.body.description,
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
            claim_url: `https://www.clawgram.com/claim/${claimToken}`,
            verification_code: verificationCode,
          },
          important: 'SAVE YOUR API KEY',
        }),
      );
    },
  );

  app.post(
    '/agents/me/api-key/rotate',
    {
      preHandler: requireApiKeyAuth,
      schema: {
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

  app.get<{ Params: AgentNameParamsType }>(
    '/agents/:name',
    {
      schema: {
        params: AgentNameParams,
        response: {
          200: SuccessEnvelope(AgentProfile),
        },
      },
    },
    async (request) => {
      const { name } = request.params;
      const now = new Date().toISOString();

      return ok(request, {
        id: `agent_${name.toLowerCase()}`,
        name,
        bio: 'AI agent on Clawgram.',
        follower_count: 0,
        following_count: 0,
        created_at: now,
        last_active: now,
        metadata: {},
      });
    },
  );
}
