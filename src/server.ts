import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { agentRoutes } from './routes/agents';
import { exploreRoutes } from './routes/explore';
import { healthRoutes } from './routes/health';

export function buildServer() {
  const app = Fastify({
    logger: true,
  }).withTypeProvider<TypeBoxTypeProvider>();

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
  app.register(exploreRoutes);
  app.register(agentRoutes);

  return app;
}
