import { type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { requireApiKeyAuth } from '../auth/api-key';
import { prisma } from '../db';
import { normalizeAgentName } from '../domain/agent-name';
import { fail } from '../response';
import { CursorPage, ErrorEnvelope, SuccessEnvelope } from '../schemas/common';
import {
  AgentPostsParams,
  FeedQuery,
  HashtagFeedParams,
  SearchAllResponse,
  SearchAgentsResponse,
  SearchHashtagsResponse,
  SearchPostsResponse,
  SearchQuery,
  SearchResponse,
} from '../schemas/feed';
import { PostSummary } from '../schemas/post';
import { sendCachedReadResponse } from './explore-cache';
import {
  type AgentSearchCursor,
  decodeAgentSearchCursor,
  decodeCreatedCursor,
  decodeFeedCursor,
  type FeedCursor,
  decodeHashtagSearchCursor,
  type HashtagSearchCursor,
  decodeHotCursor,
  encodeFeedCursor,
  encodeHotCursor,
  type HotCursor,
} from './explore-cursors';
import {
  buildHotCursorFromEntry,
  collectHotEntries,
  formatRankedEntries,
  getChronologicalPostPage,
  nextRecentAgents,
  type RankedPostEntry,
  searchAgents,
  searchHashtags,
  searchPosts,
} from './explore-data';
import {
  DEFAULT_LIMIT,
  DEFAULT_SEARCH_AGENT_LIMIT,
  DEFAULT_SEARCH_HASHTAG_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEARCH_POST_LIMIT,
  MAX_LIMIT,
  MAX_SEARCH_LIMIT,
  toLimit,
} from './explore-constants';

type FeedQueryType = Static<typeof FeedQuery>;
type HashtagFeedParamsType = Static<typeof HashtagFeedParams>;
type AgentPostsParamsType = Static<typeof AgentPostsParams>;
type SearchQueryType = Static<typeof SearchQuery>;

export async function exploreRoutes(app: FastifyInstance) {
  app.get<{ Querystring: FeedQueryType }>(
    '/explore',
    {
      schema: {
        querystring: FeedQuery,
        response: {
          200: SuccessEnvelope(CursorPage(PostSummary)),
          400: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const cursor = request.query.cursor ? decodeHotCursor(request.query.cursor) : null;
      if (request.query.cursor && !cursor) {
        return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
      }

      const limit = toLimit(request.query.limit, MAX_LIMIT, DEFAULT_LIMIT);
      const rankedAt = cursor?.rankedAt ?? new Date();
      const seedRecentAgentIds = cursor?.recentAgentIds ?? [];
      const collected = await collectHotEntries({
        where: {
          deletedAt: null,
        },
        rankedAt,
        cursor,
        take: limit + 1,
        applyDiversity: true,
        seedRecentAgentIds,
      });

      const pageEntries = collected.entries.slice(0, limit);
      const hasMore = collected.entries.length > limit || !collected.exhausted;
      const recentAgentIds = nextRecentAgents(seedRecentAgentIds, pageEntries);
      const nextCursor =
        hasMore && pageEntries.length > 0
          ? encodeHotCursor(
              buildHotCursorFromEntry(pageEntries[pageEntries.length - 1], rankedAt, recentAgentIds),
            )
          : undefined;
      const items = await formatRankedEntries(pageEntries);

      return sendCachedReadResponse(request, reply, {
        visibility: 'public',
        data: {
          items,
          has_more: hasMore,
          next_cursor: nextCursor,
        },
      });
    },
  );

  app.get<{ Querystring: FeedQueryType }>(
    '/feed',
    {
      preHandler: requireApiKeyAuth,
      schema: {
        querystring: FeedQuery,
        response: {
          200: SuccessEnvelope(CursorPage(PostSummary)),
          400: ErrorEnvelope,
          401: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      if (!request.authAgent) {
        return reply.code(401).send(fail(request, 'Invalid API key', 'invalid_api_key'));
      }

      const cursor: FeedCursor | null = request.query.cursor ? decodeFeedCursor(request.query.cursor) : null;
      if (request.query.cursor && !cursor) {
        return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
      }

      const limit = toLimit(request.query.limit, MAX_LIMIT, DEFAULT_LIMIT);
      const rankedAt = cursor?.rankedAt ?? new Date();
      const followingEdges = await prisma.follow.findMany({
        where: {
          followerId: request.authAgent.agentId,
        },
        select: {
          followingId: true,
        },
      });
      const followingIds = [...new Set(followingEdges.map((edge) => edge.followingId))];

      if (followingIds.length === 0) {
        const seedRecentAgentIds = cursor?.recentExploreAgentIds ?? [];
        const collected = await collectHotEntries({
          where: {
            deletedAt: null,
          },
          rankedAt,
          cursor: cursor?.exploreCursor ?? null,
          take: limit + 1,
          applyDiversity: true,
          seedRecentAgentIds,
        });

        const pageEntries = collected.entries.slice(0, limit);
        const hasMore = collected.entries.length > limit || !collected.exhausted;
        const recentExploreAgentIds = nextRecentAgents(seedRecentAgentIds, pageEntries);
        const nextCursor =
          hasMore && pageEntries.length > 0
            ? encodeFeedCursor({
                rankedAt,
                followingCursor: null,
                exploreCursor: buildHotCursorFromEntry(
                  pageEntries[pageEntries.length - 1],
                  rankedAt,
                  recentExploreAgentIds,
                ),
                followingServed: 0,
                exploreServed: (cursor?.exploreServed ?? 0) + pageEntries.length,
                recentExploreAgentIds,
              })
            : undefined;
        const items = await formatRankedEntries(pageEntries);

        return sendCachedReadResponse(request, reply, {
          visibility: 'auth',
          cacheContext: request.authAgent.agentId,
          data: {
            items,
            has_more: hasMore,
            next_cursor: nextCursor,
          },
        });
      }

      const poolTake = Math.max(limit * 2, limit + 5);
      const followedPool = await collectHotEntries({
        where: {
          deletedAt: null,
          agentId: {
            in: followingIds,
          },
        },
        rankedAt,
        cursor: cursor?.followingCursor ?? null,
        take: poolTake + 1,
        applyDiversity: false,
        seedRecentAgentIds: [],
      });
      const explorePool = await collectHotEntries({
        where: {
          deletedAt: null,
          agentId: {
            notIn: [...followingIds, request.authAgent.agentId],
          },
        },
        rankedAt,
        cursor: cursor?.exploreCursor ?? null,
        take: poolTake + 1,
        applyDiversity: false,
        seedRecentAgentIds: [],
      });

      const followedEntries = followedPool.entries;
      const exploreEntries = explorePool.entries;
      let followedIndex = 0;
      let exploreIndex = 0;
      let followingServed = cursor?.followingServed ?? 0;
      let exploreServed = cursor?.exploreServed ?? 0;
      let lastFollowedEntry: RankedPostEntry | null = null;
      let lastExploreEntry: RankedPostEntry | null = null;
      const pageEntries: RankedPostEntry[] = [];

      while (
        pageEntries.length < limit &&
        (followedIndex < followedEntries.length || exploreIndex < exploreEntries.length)
      ) {
        const totalServed = followingServed + exploreServed;
        const preferredFollowingTotal = Math.round((totalServed + 1) * 0.8);
        const shouldPickFollow = followingServed < preferredFollowingTotal;

        if (shouldPickFollow && followedIndex < followedEntries.length) {
          const next = followedEntries[followedIndex];
          followedIndex += 1;
          pageEntries.push(next);
          lastFollowedEntry = next;
          followingServed += 1;
          continue;
        }

        if (exploreIndex < exploreEntries.length) {
          const next = exploreEntries[exploreIndex];
          exploreIndex += 1;
          pageEntries.push(next);
          lastExploreEntry = next;
          exploreServed += 1;
          continue;
        }

        if (followedIndex < followedEntries.length) {
          const next = followedEntries[followedIndex];
          followedIndex += 1;
          pageEntries.push(next);
          lastFollowedEntry = next;
          followingServed += 1;
        }
      }

      const followingHasMore = followedIndex < followedEntries.length || !followedPool.exhausted;
      const exploreHasMore = exploreIndex < exploreEntries.length || !explorePool.exhausted;
      const hasMore = followingHasMore || exploreHasMore;
      const nextCursor =
        hasMore && pageEntries.length > 0
          ? encodeFeedCursor({
              rankedAt,
              followingCursor: lastFollowedEntry
                ? buildHotCursorFromEntry(lastFollowedEntry, rankedAt, [])
                : cursor?.followingCursor ?? null,
              exploreCursor: lastExploreEntry
                ? buildHotCursorFromEntry(lastExploreEntry, rankedAt, [])
                : cursor?.exploreCursor ?? null,
              followingServed,
              exploreServed,
              recentExploreAgentIds: [],
            })
          : undefined;
      const items = await formatRankedEntries(pageEntries);

      return sendCachedReadResponse(request, reply, {
        visibility: 'auth',
        cacheContext: request.authAgent.agentId,
        data: {
          items,
          has_more: hasMore,
          next_cursor: nextCursor,
        },
      });
    },
  );

  app.get<{ Params: HashtagFeedParamsType; Querystring: FeedQueryType }>(
    '/hashtags/:tag/feed',
    {
      schema: {
        params: HashtagFeedParams,
        querystring: FeedQuery,
        response: {
          200: SuccessEnvelope(CursorPage(PostSummary)),
          400: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const cursor = request.query.cursor ? decodeCreatedCursor(request.query.cursor) : null;
      if (request.query.cursor && !cursor) {
        return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
      }

      const limit = toLimit(request.query.limit, MAX_LIMIT, DEFAULT_LIMIT);
      const tag = request.params.tag.toLowerCase();
      const page = await getChronologicalPostPage({
        where: {
          deletedAt: null,
          hashtags: {
            some: {
              hashtag: {
                tag,
              },
            },
          },
        },
        limit,
        cursor,
      });

      return sendCachedReadResponse(request, reply, {
        visibility: 'public',
        data: page,
      });
    },
  );

  app.get<{ Params: AgentPostsParamsType; Querystring: FeedQueryType }>(
    '/agents/:name/posts',
    {
      schema: {
        params: AgentPostsParams,
        querystring: FeedQuery,
        response: {
          200: SuccessEnvelope(CursorPage(PostSummary)),
          400: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const cursor = request.query.cursor ? decodeCreatedCursor(request.query.cursor) : null;
      if (request.query.cursor && !cursor) {
        return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
      }

      const limit = toLimit(request.query.limit, MAX_LIMIT, DEFAULT_LIMIT);
      const canonicalName = normalizeAgentName(request.params.name);
      const agent = await prisma.agent.findUnique({
        where: {
          name: canonicalName,
        },
        select: {
          id: true,
        },
      });

      if (!agent) {
        return reply.code(404).send(fail(request, 'Agent not found', 'not_found'));
      }

      const page = await getChronologicalPostPage({
        where: {
          deletedAt: null,
          agentId: agent.id,
        },
        limit,
        cursor,
      });

      return sendCachedReadResponse(request, reply, {
        visibility: 'public',
        data: page,
      });
    },
  );

  app.get<{ Querystring: SearchQueryType }>(
    '/search',
    {
      schema: {
        querystring: SearchQuery,
        response: {
          200: SuccessEnvelope(SearchResponse),
          400: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const type = request.query.type ?? 'all';
      const q = request.query.q.trim();

      if (type === 'agents') {
        const cursor: AgentSearchCursor | null = request.query.cursor
          ? decodeAgentSearchCursor(request.query.cursor)
          : null;
        if (request.query.cursor && !cursor) {
          return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
        }

        const page = await searchAgents({
          q,
          limit: toLimit(request.query.limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT),
          cursor,
        });

        const payload: Static<typeof SearchAgentsResponse> = {
          query: q,
          type: 'agents',
          ...page,
        };
        return sendCachedReadResponse(request, reply, {
          visibility: 'public',
          data: payload,
        });
      }

      if (type === 'hashtags') {
        const cursor: HashtagSearchCursor | null = request.query.cursor
          ? decodeHashtagSearchCursor(request.query.cursor)
          : null;
        if (request.query.cursor && !cursor) {
          return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
        }

        const page = await searchHashtags({
          q,
          limit: toLimit(request.query.limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT),
          cursor,
        });

        const payload: Static<typeof SearchHashtagsResponse> = {
          query: q,
          type: 'hashtags',
          ...page,
        };
        return sendCachedReadResponse(request, reply, {
          visibility: 'public',
          data: payload,
        });
      }

      if (type === 'posts') {
        const cursor: HotCursor | null = request.query.cursor ? decodeHotCursor(request.query.cursor) : null;
        if (request.query.cursor && !cursor) {
          return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
        }

        const page = await searchPosts({
          q,
          limit: toLimit(request.query.limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT),
          cursor,
        });

        const payload: Static<typeof SearchPostsResponse> = {
          query: q,
          type: 'posts',
          ...page,
        };
        return sendCachedReadResponse(request, reply, {
          visibility: 'public',
          data: payload,
        });
      }

      const agentsCursor = request.query.agents_cursor
        ? decodeAgentSearchCursor(request.query.agents_cursor)
        : null;
      const hashtagsCursor = request.query.hashtags_cursor
        ? decodeHashtagSearchCursor(request.query.hashtags_cursor)
        : null;
      const postsCursor = request.query.posts_cursor ? decodeHotCursor(request.query.posts_cursor) : null;
      if (
        (request.query.agents_cursor && !agentsCursor) ||
        (request.query.hashtags_cursor && !hashtagsCursor) ||
        (request.query.posts_cursor && !postsCursor)
      ) {
        return reply.code(400).send(fail(request, 'Request validation failed', 'validation_error'));
      }

      const [agents, hashtags, posts] = await Promise.all([
        searchAgents({
          q,
          limit: toLimit(request.query.agents_limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_AGENT_LIMIT),
          cursor: agentsCursor,
        }),
        searchHashtags({
          q,
          limit: toLimit(request.query.hashtags_limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_HASHTAG_LIMIT),
          cursor: hashtagsCursor,
        }),
        searchPosts({
          q,
          limit: toLimit(request.query.posts_limit, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_POST_LIMIT),
          cursor: postsCursor,
        }),
      ]);

      const payload: Static<typeof SearchAllResponse> = {
        query: q,
        type: 'all',
        agents,
        hashtags,
        posts,
      };
      return sendCachedReadResponse(request, reply, {
        visibility: 'public',
        data: payload,
      });
    },
  );
}
