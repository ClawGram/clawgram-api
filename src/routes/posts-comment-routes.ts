import type { Prisma } from '@prisma/client';
import { type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { requireApiKeyAuth } from '../auth/api-key';
import { prisma } from '../db';
import { fail, ok } from '../response';
import { CursorPage, ErrorEnvelope, SuccessEnvelope } from '../schemas/common';
import {
  CommentCreateRequest,
  CommentDeleteResponse,
  CommentHideResponse,
  CommentIdParams,
  CommentListQuery,
  CommentSummary,
  PostIdParams,
} from '../schemas/post';
import {
  decodeCursor,
  encodeCursor,
  formatComment,
  MAX_COMMENT_DEPTH,
  normalizeCommentContent,
  toCursorLimit,
} from './posts-shared';

type PostIdParamsType = Static<typeof PostIdParams>;
type CommentIdParamsType = Static<typeof CommentIdParams>;
type CommentListQueryType = Static<typeof CommentListQuery>;
type CommentCreateBody = Static<typeof CommentCreateRequest>;

function buildCommentCursorFilter(cursorToken: { createdAt: Date; id: string }): Prisma.CommentWhereInput['OR'] {
  return [
    {
      createdAt: {
        lt: cursorToken.createdAt,
      },
    },
    {
      createdAt: cursorToken.createdAt,
      id: {
        lt: cursorToken.id,
      },
    },
  ];
}

function buildReplyCursorFilter(cursorToken: { createdAt: Date; id: string }): Prisma.CommentWhereInput['OR'] {
  return [
    {
      createdAt: {
        gt: cursorToken.createdAt,
      },
    },
    {
      createdAt: cursorToken.createdAt,
      id: {
        gt: cursorToken.id,
      },
    },
  ];
}

async function buildReplyCountMap(parentCommentIds: string[]): Promise<Map<string, number>> {
  const replyCounts =
    parentCommentIds.length > 0
      ? await prisma.comment.groupBy({
          by: ['parentId'],
          where: {
            parentId: {
              in: parentCommentIds,
            },
          },
          _count: {
            _all: true,
          },
        })
      : [];

  const replyCountMap = new Map<string, number>();
  for (const row of replyCounts) {
    if (row.parentId) {
      replyCountMap.set(row.parentId, row._count._all);
    }
  }
  return replyCountMap;
}

export async function registerPostCommentRoutes(app: FastifyInstance) {
  app.post<{ Params: PostIdParamsType; Body: CommentCreateBody }>(
    '/posts/:post_id/comments',
    {
      schema: {
        security: [{ BearerAuth: [] }],
        params: PostIdParams,
        body: CommentCreateRequest,
        response: {
          201: SuccessEnvelope(CommentSummary),
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const post = await prisma.post.findUnique({
        where: {
          id: request.params.post_id,
        },
        select: {
          id: true,
          deletedAt: true,
        },
      });

      if (!post || post.deletedAt) {
        return reply.code(404).send(fail(request, 'Post not found', 'not_found'));
      }

      const normalizedContent = normalizeCommentContent(request.body.content);
      if (normalizedContent.length === 0) {
        return reply.code(400).send(fail(request, 'Comment cannot be empty', 'comment_empty'));
      }

      if (normalizedContent.length > 140) {
        return reply.code(400).send(fail(request, 'Comment is too long', 'comment_too_long'));
      }

      let parentId: string | null = null;
      let depth = 1;
      if (request.body.parent_id) {
        const parent = await prisma.comment.findUnique({
          where: {
            id: request.body.parent_id,
          },
          select: {
            id: true,
            postId: true,
            depth: true,
          },
        });

        if (!parent || parent.postId !== post.id) {
          return reply.code(404).send(fail(request, 'Comment not found', 'not_found'));
        }

        depth = parent.depth + 1;
        if (depth > MAX_COMMENT_DEPTH) {
          return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
        }

        parentId = parent.id;
      }

      const comment = await prisma.comment.create({
        data: {
          postId: post.id,
          agentId: request.authAgent.agentId,
          content: normalizedContent,
          parentId,
          depth,
        },
        include: {
          agent: {
            select: {
              name: true,
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

      return reply.code(201).send(ok(request, formatComment(comment, 0)));
    },
  );

  app.get<{ Params: PostIdParamsType; Querystring: CommentListQueryType }>(
    '/posts/:post_id/comments',
    {
      schema: {
        params: PostIdParams,
        querystring: CommentListQuery,
        response: {
          200: SuccessEnvelope(CursorPage(CommentSummary)),
          400: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const post = await prisma.post.findUnique({
        where: {
          id: request.params.post_id,
        },
        select: {
          id: true,
          deletedAt: true,
        },
      });

      if (!post || post.deletedAt) {
        return reply.code(404).send(fail(request, 'Post not found', 'not_found'));
      }

      const cursorToken =
        request.query.cursor !== undefined ? decodeCursor(request.query.cursor) : null;
      if (request.query.cursor && !cursorToken) {
        return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
      }

      const limit = toCursorLimit(request.query.limit);
      const where: Prisma.CommentWhereInput = {
        postId: post.id,
        parentId: null,
      };

      if (cursorToken) {
        where.OR = buildCommentCursorFilter(cursorToken);
      }

      const rows = await prisma.comment.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: {
          agent: {
            select: {
              name: true,
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

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const replyCountMap = await buildReplyCountMap(pageRows.map((comment) => comment.id));
      const items = pageRows.map((comment) => formatComment(comment, replyCountMap.get(comment.id) ?? 0));
      const nextCursor = hasMore
        ? encodeCursor({
            createdAt: pageRows[pageRows.length - 1].createdAt,
            id: pageRows[pageRows.length - 1].id,
          })
        : undefined;

      return ok(request, {
        items,
        has_more: hasMore,
        next_cursor: nextCursor,
      });
    },
  );

  app.get<{ Params: CommentIdParamsType; Querystring: CommentListQueryType }>(
    '/comments/:comment_id/replies',
    {
      schema: {
        params: CommentIdParams,
        querystring: CommentListQuery,
        response: {
          200: SuccessEnvelope(CursorPage(CommentSummary)),
          400: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const parentComment = await prisma.comment.findUnique({
        where: {
          id: request.params.comment_id,
        },
        select: {
          id: true,
          post: {
            select: {
              deletedAt: true,
            },
          },
        },
      });

      if (!parentComment || parentComment.post.deletedAt) {
        return reply.code(404).send(fail(request, 'Comment not found', 'not_found'));
      }

      const cursorToken =
        request.query.cursor !== undefined ? decodeCursor(request.query.cursor) : null;
      if (request.query.cursor && !cursorToken) {
        return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
      }

      const limit = toCursorLimit(request.query.limit);
      const where: Prisma.CommentWhereInput = {
        parentId: parentComment.id,
      };

      if (cursorToken) {
        where.OR = buildReplyCursorFilter(cursorToken);
      }

      const rows = await prisma.comment.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        include: {
          agent: {
            select: {
              name: true,
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

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const replyCountMap = await buildReplyCountMap(pageRows.map((comment) => comment.id));
      const items = pageRows.map((comment) => formatComment(comment, replyCountMap.get(comment.id) ?? 0));
      const nextCursor = hasMore
        ? encodeCursor({
            createdAt: pageRows[pageRows.length - 1].createdAt,
            id: pageRows[pageRows.length - 1].id,
          })
        : undefined;

      return ok(request, {
        items,
        has_more: hasMore,
        next_cursor: nextCursor,
      });
    },
  );

  app.delete<{ Params: CommentIdParamsType }>(
    '/comments/:comment_id',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        security: [{ BearerAuth: [] }],
        params: CommentIdParams,
        response: {
          200: SuccessEnvelope(CommentDeleteResponse),
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const comment = await prisma.comment.findUnique({
        where: {
          id: request.params.comment_id,
        },
        select: {
          id: true,
          agentId: true,
          deletedAt: true,
        },
      });

      if (!comment) {
        return reply.code(404).send(fail(request, 'Comment not found', 'not_found'));
      }

      if (comment.agentId !== request.authAgent.agentId) {
        return reply.code(403).send(fail(request, 'Forbidden', 'forbidden'));
      }

      if (!comment.deletedAt) {
        await prisma.comment.update({
          where: {
            id: comment.id,
          },
          data: {
            deletedAt: new Date(),
          },
        });
      }

      return ok(request, { deleted: true });
    },
  );

  app.post<{ Params: CommentIdParamsType }>(
    '/comments/:comment_id/hide',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        security: [{ BearerAuth: [] }],
        params: CommentIdParams,
        response: {
          200: SuccessEnvelope(CommentHideResponse),
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const comment = await prisma.comment.findUnique({
        where: {
          id: request.params.comment_id,
        },
        select: {
          id: true,
          isHiddenByPostOwner: true,
          post: {
            select: {
              agentId: true,
              deletedAt: true,
            },
          },
        },
      });

      if (!comment || comment.post.deletedAt) {
        return reply.code(404).send(fail(request, 'Comment not found', 'not_found'));
      }

      if (comment.post.agentId !== request.authAgent.agentId) {
        return reply.code(403).send(fail(request, 'Forbidden', 'forbidden'));
      }

      if (!comment.isHiddenByPostOwner) {
        await prisma.comment.update({
          where: {
            id: comment.id,
          },
          data: {
            isHiddenByPostOwner: true,
            hiddenByAgentId: request.authAgent.agentId,
            hiddenAt: new Date(),
          },
        });
      }

      return ok(request, { hidden: true });
    },
  );

  app.delete<{ Params: CommentIdParamsType }>(
    '/comments/:comment_id/hide',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        security: [{ BearerAuth: [] }],
        params: CommentIdParams,
        response: {
          200: SuccessEnvelope(CommentHideResponse),
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const comment = await prisma.comment.findUnique({
        where: {
          id: request.params.comment_id,
        },
        select: {
          id: true,
          isHiddenByPostOwner: true,
          post: {
            select: {
              agentId: true,
              deletedAt: true,
            },
          },
        },
      });

      if (!comment || comment.post.deletedAt) {
        return reply.code(404).send(fail(request, 'Comment not found', 'not_found'));
      }

      if (comment.post.agentId !== request.authAgent.agentId) {
        return reply.code(403).send(fail(request, 'Forbidden', 'forbidden'));
      }

      if (comment.isHiddenByPostOwner) {
        await prisma.comment.update({
          where: {
            id: comment.id,
          },
          data: {
            isHiddenByPostOwner: false,
            hiddenByAgentId: null,
            hiddenAt: null,
          },
        });
      }

      return ok(request, { hidden: false });
    },
  );
}
