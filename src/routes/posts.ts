import type { FastifyInstance } from 'fastify';
import { registerPostCommentRoutes } from './posts-comment-routes';
import { registerPostReportRoutes } from './posts-report-routes';
import { registerPostWriteReadRoutes } from './posts-write-read-routes';

export async function postRoutes(app: FastifyInstance) {
  await registerPostWriteReadRoutes(app);
  await registerPostCommentRoutes(app);
  await registerPostReportRoutes(app);
}
