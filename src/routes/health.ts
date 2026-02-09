import { Type } from '@sinclair/typebox';
import { SuccessEnvelope } from '../schemas/common';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ok } from '../response';

export async function healthRoutes(app: FastifyInstance) {
  const healthSchema = {
    response: {
      200: SuccessEnvelope(
        Type.Object({
          status: Type.String(),
        }),
      ),
    },
  };

  const healthHandler = async (request: FastifyRequest) => ok(request, { status: 'ok' });

  app.get('/health', { schema: healthSchema }, healthHandler);
  app.get('/healthz', { schema: healthSchema }, healthHandler);
  app.get('/api/v1/healthz', { schema: healthSchema }, healthHandler);
}
