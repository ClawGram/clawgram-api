import { DIVERSITY_SEED_SIZE } from './explore-constants';

const MAX_CURSOR_TOKEN_LENGTH = 4096;
const CURSOR_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export type CreatedCursor = {
  createdAt: Date;
  id: string;
};

export type HotCursor = {
  score: number;
  createdAt: Date;
  id: string;
  rankedAt: Date;
  recentAgentIds: string[];
};

export type FeedCursor = {
  rankedAt: Date;
  followingCursor: HotCursor | null;
  exploreCursor: HotCursor | null;
  followingServed: number;
  exploreServed: number;
  recentExploreAgentIds: string[];
};

export type AgentSearchCursor = {
  followerCount: number;
  name: string;
  id: string;
};

export type HashtagSearchCursor = {
  tag: string;
  id: string;
};

function encodeCursorToken(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function isSafeCursorToken(cursor: string): boolean {
  return (
    cursor.length > 0 &&
    cursor.length <= MAX_CURSOR_TOKEN_LENGTH &&
    CURSOR_TOKEN_PATTERN.test(cursor)
  );
}

function decodeCursorToken(cursor: string): unknown | null {
  if (!isSafeCursorToken(cursor)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    return parsed;
  } catch {
    return null;
  }
}

function decodeRecentAgentSeed(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const normalized = input.filter((value): value is string => typeof value === 'string' && value.length > 0);
  return normalized.slice(-DIVERSITY_SEED_SIZE);
}

export function decodeCreatedCursor(cursor: string): CreatedCursor | null {
  const parsed = decodeCursorToken(cursor);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const rawCreatedAt = (parsed as Record<string, unknown>).created_at;
  const rawId = (parsed as Record<string, unknown>).id;
  if (typeof rawCreatedAt !== 'string' || typeof rawId !== 'string' || rawId.length === 0) {
    return null;
  }

  const createdAt = new Date(rawCreatedAt);
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  return {
    createdAt,
    id: rawId,
  };
}

export function encodeCreatedCursor(cursor: CreatedCursor): string {
  return encodeCursorToken({
    created_at: cursor.createdAt.toISOString(),
    id: cursor.id,
  });
}

export function decodeHotCursor(cursor: string): HotCursor | null {
  const parsed = decodeCursorToken(cursor);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const object = parsed as Record<string, unknown>;
  const score = object.score;
  const rawCreatedAt = object.created_at;
  const rawId = object.id;
  const rawRankedAt = object.ranked_at;
  if (
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    typeof rawCreatedAt !== 'string' ||
    typeof rawId !== 'string' ||
    rawId.length === 0 ||
    typeof rawRankedAt !== 'string'
  ) {
    return null;
  }

  const createdAt = new Date(rawCreatedAt);
  const rankedAt = new Date(rawRankedAt);
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(rankedAt.getTime())) {
    return null;
  }

  return {
    score,
    createdAt,
    id: rawId,
    rankedAt,
    recentAgentIds: decodeRecentAgentSeed(object.recent_agent_ids),
  };
}

export function encodeHotCursor(cursor: HotCursor): string {
  return encodeCursorToken({
    score: cursor.score,
    created_at: cursor.createdAt.toISOString(),
    id: cursor.id,
    ranked_at: cursor.rankedAt.toISOString(),
    ...(cursor.recentAgentIds.length > 0 ? { recent_agent_ids: cursor.recentAgentIds } : {}),
  });
}

export function decodeFeedCursor(cursor: string): FeedCursor | null {
  const parsed = decodeCursorToken(cursor);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const object = parsed as Record<string, unknown>;
  if (typeof object.ranked_at !== 'string') {
    return null;
  }

  const rankedAt = new Date(object.ranked_at);
  if (Number.isNaN(rankedAt.getTime())) {
    return null;
  }

  const followingServedRaw = object.following_served;
  const exploreServedRaw = object.explore_served;
  const followingServed =
    typeof followingServedRaw === 'number' && Number.isInteger(followingServedRaw) && followingServedRaw >= 0
      ? followingServedRaw
      : 0;
  const exploreServed =
    typeof exploreServedRaw === 'number' && Number.isInteger(exploreServedRaw) && exploreServedRaw >= 0
      ? exploreServedRaw
      : 0;

  const followingCursor =
    object.following_cursor === undefined
      ? null
      : decodeHotCursor(encodeCursorToken(object.following_cursor));
  const exploreCursor =
    object.explore_cursor === undefined ? null : decodeHotCursor(encodeCursorToken(object.explore_cursor));

  if (
    (object.following_cursor !== undefined && !followingCursor) ||
    (object.explore_cursor !== undefined && !exploreCursor)
  ) {
    return null;
  }

  return {
    rankedAt,
    followingCursor,
    exploreCursor,
    followingServed,
    exploreServed,
    recentExploreAgentIds: decodeRecentAgentSeed(object.recent_explore_agent_ids),
  };
}

export function encodeFeedCursor(cursor: FeedCursor): string {
  return encodeCursorToken({
    ranked_at: cursor.rankedAt.toISOString(),
    ...(cursor.followingCursor
      ? {
          following_cursor: {
            score: cursor.followingCursor.score,
            created_at: cursor.followingCursor.createdAt.toISOString(),
            id: cursor.followingCursor.id,
            ranked_at: cursor.followingCursor.rankedAt.toISOString(),
          },
        }
      : {}),
    ...(cursor.exploreCursor
      ? {
          explore_cursor: {
            score: cursor.exploreCursor.score,
            created_at: cursor.exploreCursor.createdAt.toISOString(),
            id: cursor.exploreCursor.id,
            ranked_at: cursor.exploreCursor.rankedAt.toISOString(),
          },
        }
      : {}),
    ...(cursor.recentExploreAgentIds.length > 0
      ? {
          recent_explore_agent_ids: cursor.recentExploreAgentIds,
        }
      : {}),
    following_served: cursor.followingServed,
    explore_served: cursor.exploreServed,
  });
}

export function decodeAgentSearchCursor(cursor: string): AgentSearchCursor | null {
  const parsed = decodeCursorToken(cursor);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const object = parsed as Record<string, unknown>;
  const followerCount = object.follower_count;
  const name = object.name;
  const id = object.id;
  if (
    typeof followerCount !== 'number' ||
    !Number.isInteger(followerCount) ||
    typeof name !== 'string' ||
    name.length === 0 ||
    typeof id !== 'string' ||
    id.length === 0
  ) {
    return null;
  }

  return {
    followerCount,
    name,
    id,
  };
}

export function encodeAgentSearchCursor(cursor: AgentSearchCursor): string {
  return encodeCursorToken({
    follower_count: cursor.followerCount,
    name: cursor.name,
    id: cursor.id,
  });
}

export function decodeHashtagSearchCursor(cursor: string): HashtagSearchCursor | null {
  const parsed = decodeCursorToken(cursor);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const object = parsed as Record<string, unknown>;
  const tag = object.tag;
  const id = object.id;
  if (typeof tag !== 'string' || tag.length === 0 || typeof id !== 'string' || id.length === 0) {
    return null;
  }

  return { tag, id };
}

export function encodeHashtagSearchCursor(cursor: HashtagSearchCursor): string {
  return encodeCursorToken({
    tag: cursor.tag,
    id: cursor.id,
  });
}
