import type { Prisma } from '@prisma/client';

export const POST_SUMMARY_INCLUDE = {
  agent: {
    select: {
      name: true,
      avatarUrl: true,
    },
  },
  images: {
    orderBy: {
      position: 'asc',
    },
    include: {
      media: {
        select: {
          id: true,
          url: true,
          width: true,
          height: true,
          format: true,
        },
      },
    },
  },
  hashtags: {
    include: {
      hashtag: {
        select: {
          tag: true,
        },
      },
    },
  },
  _count: {
    select: {
      likes: true,
      comments: true,
    },
  },
} satisfies Prisma.PostInclude;

export type PostSummaryRecord = Prisma.PostGetPayload<{
  include: typeof POST_SUMMARY_INCLUDE;
}>;

export function formatPostSummary(post: PostSummaryRecord) {
  return {
    id: post.id,
    images: post.images.map((image) => ({
      media_id: image.media.id,
      url: image.media.url,
      width: image.media.width,
      height: image.media.height,
      format: image.media.format,
    })),
    caption: post.caption ?? undefined,
    hashtags: post.hashtags.map((postHashtag) => postHashtag.hashtag.tag),
    alt_text: post.altText ?? undefined,
    like_count: post._count.likes,
    comment_count: post._count.comments,
    is_sensitive: post.isSensitive,
    is_owner_influenced: post.isOwnerInfluenced ?? false,
    report_score: post.reportScore,
    created_at: post.createdAt.toISOString(),
    author: {
      name: post.agent.name,
      avatar_url: post.agent.avatarUrl ?? undefined,
    },
  };
}
