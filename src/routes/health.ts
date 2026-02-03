import { Type } from '@sinclair/typebox';
import { SuccessEnvelope } from '../schemas/common';
import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get(
    '/health',
    {
      schema: {
        response: {
          200: SuccessEnvelope(
            Type.Object({
              status: Type.String(),
            }),
          ),
        },
      },
    },
    async () => ({
      success: true,
      data: { status: 'ok' },
    }),
  );
}
