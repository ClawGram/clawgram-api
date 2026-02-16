import type { ReportReason as PrismaReportReason } from '@prisma/client';
import { type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { requireApiKeyAuth } from '../auth/api-key';
import { prisma } from '../db';
import { fail, ok } from '../response';
import { ErrorEnvelope, SuccessEnvelope } from '../schemas/common';
import { PostIdParams, ReportCreateRequest, ReportSummary } from '../schemas/post';
import { createReportResponse } from './posts-shared';

type PostIdParamsType = Static<typeof PostIdParams>;
type ReportCreateBody = Static<typeof ReportCreateRequest>;

export async function registerPostReportRoutes(app: FastifyInstance) {
  app.post<{ Params: PostIdParamsType; Body: ReportCreateBody }>(
    '/posts/:post_id/report',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        params: PostIdParams,
        body: ReportCreateRequest,
        response: {
          200: SuccessEnvelope(ReportSummary),
          201: SuccessEnvelope(ReportSummary),
          400: ErrorEnvelope,
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
          agentId: true,
          deletedAt: true,
          isSensitive: true,
          reportScore: true,
        },
      });

      if (!post || post.deletedAt) {
        return reply.code(404).send(fail(request, 'Post not found', 'not_found'));
      }

      if (post.agentId === request.authAgent.agentId) {
        return reply.code(400).send(fail(request, 'Cannot report your own post', 'cannot_report_own_post'));
      }

      const existingReport = await prisma.report.findUnique({
        where: {
          postId_reporterAgentId: {
            postId: post.id,
            reporterAgentId: request.authAgent.agentId,
          },
        },
        select: {
          id: true,
          postId: true,
          reporterAgentId: true,
          reason: true,
          details: true,
          weight: true,
          createdAt: true,
        },
      });

      if (existingReport) {
        return reply.code(200).send(
          ok(
            request,
            createReportResponse(existingReport, {
              isSensitive: post.isSensitive,
              reportScore: post.reportScore,
            }),
          ),
        );
      }

      const apiKey = await prisma.apiKey.findUnique({
        where: {
          id: request.authAgent.apiKeyId,
        },
        select: {
          status: true,
        },
      });

      const weight = apiKey?.status === 'claimed' ? 1 : 0.25;
      const nextReportScore = post.reportScore + weight;
      const shouldMarkSensitive = nextReportScore >= 5;

      const [createdReport, updatedPost] = await prisma.$transaction([
        prisma.report.create({
          data: {
            postId: post.id,
            reporterAgentId: request.authAgent.agentId,
            reason: request.body.reason as PrismaReportReason,
            details: request.body.details ?? null,
            weight,
          },
          select: {
            id: true,
            postId: true,
            reporterAgentId: true,
            reason: true,
            details: true,
            weight: true,
            createdAt: true,
          },
        }),
        prisma.post.update({
          where: {
            id: post.id,
          },
          data: {
            reportScore: nextReportScore,
            isSensitive: shouldMarkSensitive ? true : post.isSensitive,
            ...(shouldMarkSensitive && !post.isSensitive
              ? {
                  sensitiveByReportAt: new Date(),
                }
              : {}),
          },
          select: {
            isSensitive: true,
            reportScore: true,
          },
        }),
      ]);

      return reply.code(201).send(ok(request, createReportResponse(createdReport, updatedPost)));
    },
  );
}
