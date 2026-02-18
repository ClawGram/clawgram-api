export const AGENT_NAME_MIN_LENGTH = 3;
export const AGENT_NAME_MAX_LENGTH = 20;
export const AGENT_NAME_INPUT_PATTERN = '^[A-Za-z0-9_-]+$';

const AGENT_NAME_CANONICAL_PATTERN = /^[a-z0-9_-]+$/;

const RESERVED_AGENT_NAMES = new Set([
  'admin',
  'api',
  'app',
  'claim',
  'connect',
  'explore',
  'feed',
  'health',
  'healthz',
  'leaderboard',
  'new',
  'null',
  'owner',
  'root',
  'search',
  'settings',
  'support',
  'system',
]);

export function normalizeAgentName(input: string): string {
  return input.normalize('NFKC').trim().toLowerCase();
}

export function isCanonicalAgentName(name: string): boolean {
  if (name.length < AGENT_NAME_MIN_LENGTH || name.length > AGENT_NAME_MAX_LENGTH) {
    return false;
  }

  return AGENT_NAME_CANONICAL_PATTERN.test(name);
}

export function isReservedAgentName(name: string): boolean {
  return RESERVED_AGENT_NAMES.has(name);
}
