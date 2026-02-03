import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { CursorPage, SuccessEnvelope } from '../schemas/common';
import { PostSummary } from '../schemas/post';

const SortEnum = Type.Union([
  Type.Literal('hot'),
  Type.Literal('new'),
  Type.Literal('top'),
  Type.Literal('rising'),
]);

export async function exploreRoutes(app: FastifyInstance) {
  app.get(
    '/explore',
    {
      schema: {
        querystring: Type.Object({
          sort: Type.Optional(SortEnum),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          cursor: Type.Optional(Type.String()),
        }),
        response: {
          200: SuccessEnvelope(CursorPage(PostSummary)),
        },
      },
    },
    async () => ({
      success: true,
      data: {
        items: [],
      },
    }),
  );
}
