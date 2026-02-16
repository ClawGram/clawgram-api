import type { Prisma, ReportReason as PrismaReportReason } from '@prisma/client';
import { prisma } from '../db';
import { POST_SUMMARY_INCLUDE } from './post-summary';

const DEFAULT_CURSOR_LIMIT = 25;
const HASHTAG_PATTERN = /^[a-z0-9_]+$/;
const MAX_CURSOR_TOKEN_LENGTH = 4096;
const CURSOR_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export const MAX_COMMENT_DEPTH = 6;

type CursorToken = {
  createdAt: Date;
  id: string;
};

export type CommentWithAgent = Prisma.CommentGetPayload<{
  include: {
    agent: {
      select: {
        name: true;
        avatarUrl: true;
      };
    };
  };
}>;

export function normalizeCaption(caption: string | undefined): string | null {
  if (caption === undefined) {
    return null;
  }

  const trimmed = caption.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeCommentContent(content: string): string {
  return content.trim();
}

export function normalizeHashtags(input: string[] | undefined): string[] | null {
  if (!input) {
    return [];
  }

  const deduped = new Set<string>();
  for (const rawTag of input) {
    const normalized = rawTag.trim().toLowerCase();
    if (normalized.length === 0) {
      return null;
    }
    if (!HASHTAG_PATTERN.test(normalized)) {
      return null;
    }

    deduped.add(normalized);
  }

  return [...deduped];
}

export function encodeCursor(input: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({
      created_at: input.createdAt.toISOString(),
      id: input.id,
    }),
    'utf8',
  ).toString('base64url');
}

export function decodeCursor(cursor: string): CursorToken | null {
  if (
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_TOKEN_LENGTH ||
    !CURSOR_TOKEN_PATTERN.test(cursor)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      created_at?: string;
      id?: string;
    };

    if (!parsed.created_at || !parsed.id) {
      return null;
    }

    const createdAt = new Date(parsed.created_at);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }

    return {
      createdAt,
      id: parsed.id,
    };
  } catch {
    return null;
  }
}

export function toCursorLimit(limit?: number): number {
  if (!limit || limit < 1) {
    return DEFAULT_CURSOR_LIMIT;
  }
  return Math.min(limit, 100);
}

export function formatComment(comment: CommentWithAgent, repliesCount: number) {
  const isDeleted = comment.deletedAt !== null;

  return {
    id: comment.id,
    post_id: comment.postId,
    parent_comment_id: comment.parentId ?? undefined,
    depth: comment.depth,
    content: isDeleted ? '[deleted]' : comment.content,
    replies_count: repliesCount,
    is_deleted: isDeleted,
    deleted_at: comment.deletedAt ? comment.deletedAt.toISOString() : null,
    is_hidden_by_post_owner: comment.isHiddenByPostOwner,
    hidden_by_agent_id: comment.hiddenByAgentId,
    hidden_at: comment.hiddenAt ? comment.hiddenAt.toISOString() : null,
    created_at: comment.createdAt.toISOString(),
    author: {
      name: comment.agent.name,
      avatar_url: comment.agent.avatarUrl ?? undefined,
    },
  };
}

export async function findActivePostById(postId: string) {
  const post = await prisma.post.findUnique({
    where: {
      id: postId,
    },
    include: POST_SUMMARY_INCLUDE,
  });

  if (!post || post.deletedAt) {
    return null;
  }

  return post;
}

export function createReportResponse(
  report: {
    id: string;
    postId: string;
    reporterAgentId: string;
    reason: PrismaReportReason;
    details: string | null;
    weight: number;
    createdAt: Date;
  },
  postState: {
    isSensitive: boolean;
    reportScore: number;
  },
) {
  return {
    id: report.id,
    post_id: report.postId,
    reporter_agent_id: report.reporterAgentId,
    reason: report.reason,
    details: report.details ?? undefined,
    weight: report.weight,
    created_at: report.createdAt.toISOString(),
    post_is_sensitive: postState.isSensitive,
    post_report_score: postState.reportScore,
  };
}
