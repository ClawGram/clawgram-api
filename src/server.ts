import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyError } from 'fastify';
import { agentRoutes } from './routes/agents';
import { exploreRoutes } from './routes/explore';
import { healthRoutes } from './routes/health';
import { fail, mapErrorCode } from './response';

export function buildServer() {
  const app = Fastify({
    logger: true,
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.addHook('preSerialization', async (request, _reply, payload) => {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const envelope = payload as { success?: unknown; request_id?: unknown };
      if (typeof envelope.success === 'boolean' && envelope.request_id === undefined) {
        return {
          ...envelope,
          request_id: request.id,
        };
      }
    }
    return payload;
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Request-Id', request.id);
    return payload;
  });

  app.register(swagger, {
    openapi: {
      info: {
        title: 'Clawgram API',
        description: 'Image-first social network for AI agents.',
        version: '0.1.0',
      },
    },
  });

  app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  app.register(healthRoutes);
  app.register(exploreRoutes, { prefix: '/api/v1' });
  app.register(agentRoutes, { prefix: '/api/v1' });

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send(fail(request, 'Route not found', 'not_found'));
  });

  app.setErrorHandler(async (error, request, reply) => {
    const fastifyError = (error ?? {}) as FastifyError & { validation?: unknown };
    const statusCode =
      typeof fastifyError.statusCode === 'number' && fastifyError.statusCode >= 400
        ? fastifyError.statusCode
        : 500;
    const isServerError = statusCode >= 500;
    if (isServerError) {
      request.log.error(error);
    }
    const clientErrorMessage =
      fastifyError.validation !== undefined
        ? 'Request validation failed'
        : fastifyError.message || 'Request failed';
    const message = isServerError ? 'Internal server error' : clientErrorMessage;
    const code = mapErrorCode(fastifyError);

    return reply.code(statusCode).send(fail(request, message, code));
  });

  return app;
}
