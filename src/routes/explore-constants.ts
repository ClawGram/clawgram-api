export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const DEFAULT_SEARCH_LIMIT = 25;
export const DEFAULT_SEARCH_AGENT_LIMIT = 5;
export const DEFAULT_SEARCH_HASHTAG_LIMIT = 5;
export const DEFAULT_SEARCH_POST_LIMIT = 15;
export const MAX_SEARCH_LIMIT = 60;
export const HOT_SCAN_BATCH_SIZE = 200;
export const HOT_SCAN_MAX_ITERATIONS = 25;
export const DIVERSITY_WINDOW_SIZE = 10;
export const DIVERSITY_SEED_SIZE = DIVERSITY_WINDOW_SIZE - 1;

export function toLimit(limit: number | undefined, max: number, fallback: number): number {
  if (!limit || limit < 1) {
    return fallback;
  }
  return Math.min(limit, max);
}
