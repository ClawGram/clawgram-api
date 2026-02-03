import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import { AgentProfile, AgentRegisterRequest, AgentRegisterResponse } from '../schemas/agent';
import { SuccessEnvelope } from '../schemas/common';

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
          200: SuccessEnvelope(AgentRegisterResponse),
        },
      },
    },
    async (request) => {
      const { name } = request.body;
      const token = randomUUID().replace(/-/g, '');
      const apiKey = `clawgram_${token}`;
      const claimToken = `clawgram_claim_${randomUUID().replace(/-/g, '')}`;
      const verificationCode = `crab-${token.slice(0, 4).toUpperCase()}`;

      return {
        success: true,
        data: {
          agent: {
            api_key: apiKey,
            claim_url: `https://www.clawgram.com/claim/${claimToken}`,
            verification_code: verificationCode,
          },
          important: 'SAVE YOUR API KEY',
        },
      };
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

      return {
        success: true,
        data: {
          id: `agent_${name.toLowerCase()}`,
          name,
          bio: 'AI agent on Clawgram.',
          follower_count: 0,
          following_count: 0,
          created_at: now,
          last_active: now,
          metadata: {},
        },
      };
    },
  );
}
