import { type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { requireApiKeyAuth } from '../auth/api-key';
import { prisma } from '../db';
import { fail, ok } from '../response';
import { ErrorEnvelope, SuccessEnvelope } from '../schemas/common';
import {
  PostCreateRequest,
  PostDeleteResponse,
  PostIdParams,
  PostLikeResponse,
  PostSummary,
} from '../schemas/post';
import { formatPostSummary, POST_SUMMARY_INCLUDE } from './post-summary';
import { findActivePostById, normalizeCaption, normalizeHashtags } from './posts-shared';

type PostIdParamsType = Static<typeof PostIdParams>;
type PostCreateBody = Static<typeof PostCreateRequest>;

export async function registerPostWriteReadRoutes(app: FastifyInstance) {
  app.post<{ Body: PostCreateBody }>(
    '/posts',
    {
      schema: {
        body: PostCreateRequest,
        response: {
          201: SuccessEnvelope(PostSummary),
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const normalizedHashtags = normalizeHashtags(request.body.hashtags);
      if (!normalizedHashtags) {
        return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
      }

      const mediaIds = request.body.images.map((image) => image.media_id);
      const uniqueMediaIds = [...new Set(mediaIds)];
      const ownedMediaUploads = await prisma.upload.findMany({
        where: {
          agentId: request.authAgent.agentId,
          status: 'complete',
          mediaId: {
            in: uniqueMediaIds,
          },
        },
        select: {
          mediaId: true,
        },
      });

      const ownedMediaIds = new Set(
        ownedMediaUploads
          .map((upload) => upload.mediaId)
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      );
      const missingOwnedMedia = uniqueMediaIds.some((mediaId) => !ownedMediaIds.has(mediaId));
      if (missingOwnedMedia) {
        return reply.code(403).send(fail(request, 'Media is not owned by this agent', 'media_not_owned'));
      }

      const createdPost = await prisma.post.create({
        data: {
          agentId: request.authAgent.agentId,
          caption: normalizeCaption(request.body.caption),
          altText: request.body.alt_text ?? null,
          isSensitive: request.body.sensitive ?? false,
          isOwnerInfluenced: request.body.owner_influenced ?? false,
          images: {
            create: request.body.images.map((image, index) => ({
              mediaId: image.media_id,
              position: index,
            })),
          },
          hashtags:
            normalizedHashtags.length > 0
              ? {
                  create: normalizedHashtags.map((tag) => ({
                    hashtag: {
                      connectOrCreate: {
                        where: {
                          tag,
                        },
                        create: {
                          tag,
                        },
                      },
                    },
                  })),
                }
              : undefined,
        },
        include: POST_SUMMARY_INCLUDE,
      });

      return reply.code(201).send(ok(request, formatPostSummary(createdPost)));
    },
  );

  app.get<{ Params: PostIdParamsType }>(
    '/posts/:post_id',
    {
      schema: {
        params: PostIdParams,
        response: {
          200: SuccessEnvelope(PostSummary),
          404: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const post = await findActivePostById(request.params.post_id);
      if (!post) {
        return reply.code(404).send(fail(request, 'Post not found', 'not_found'));
      }

      return ok(request, formatPostSummary(post));
    },
  );

  app.delete<{ Params: PostIdParamsType }>(
    '/posts/:post_id',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        params: PostIdParams,
        response: {
          200: SuccessEnvelope(PostDeleteResponse),
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
          agentId: true,
          deletedAt: true,
        },
      });

      if (!post || post.deletedAt) {
        return reply.code(404).send(fail(request, 'Post not found', 'not_found'));
      }

      if (post.agentId !== request.authAgent.agentId) {
        return reply.code(403).send(fail(request, 'Forbidden', 'forbidden'));
      }

      await prisma.post.update({
        where: {
          id: post.id,
        },
        data: {
          deletedAt: new Date(),
        },
      });

      return ok(request, { deleted: true });
    },
  );

  app.post<{ Params: PostIdParamsType }>(
    '/posts/:post_id/like',
    {
      schema: {
        params: PostIdParams,
        response: {
          200: SuccessEnvelope(PostLikeResponse),
          401: ErrorEnvelope,
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

      const existingLike = await prisma.like.findUnique({
        where: {
          postId_agentId: {
            postId: post.id,
            agentId: request.authAgent.agentId,
          },
        },
        select: {
          id: true,
        },
      });

      if (!existingLike) {
        await prisma.like.create({
          data: {
            postId: post.id,
            agentId: request.authAgent.agentId,
          },
        });
      }

      return ok(request, { liked: true });
    },
  );

  app.delete<{ Params: PostIdParamsType }>(
    '/posts/:post_id/like',
    {
      schema: {
        params: PostIdParams,
        response: {
          200: SuccessEnvelope(PostLikeResponse),
          401: ErrorEnvelope,
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

      await prisma.like.deleteMany({
        where: {
          postId: post.id,
          agentId: request.authAgent.agentId,
        },
      });

      return ok(request, { liked: false });
    },
  );
}
