import type { FastifyInstance } from 'fastify';
import { registerOwnerEmailRoutes } from './owner-email-routes';
import { registerOwnerManagementRoutes } from './owner-management-routes';

export async function ownerRoutes(app: FastifyInstance) {
  await registerOwnerEmailRoutes(app);
  await registerOwnerManagementRoutes(app);
}
