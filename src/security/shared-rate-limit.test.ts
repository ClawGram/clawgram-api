import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  prisma: {},
}));

import {
  consumeSharedRateLimitKey,
  resetSharedRateLimitFallbackStateForTest,
} from './shared-rate-limit';

describe('shared-rate-limit fallback storage', () => {
  beforeEach(() => {
    resetSharedRateLimitFallbackStateForTest();
  });

  it('allows requests up to the configured limit and then limits', async () => {
    const first = await consumeSharedRateLimitKey({
      scope: 'test:register',
      key: '127.0.0.1',
      limit: 2,
      windowMs: 1_000,
      nowMs: 1_000,
    });
    expect(first.limited).toBe(false);
    expect(first.remaining).toBe(1);

    const second = await consumeSharedRateLimitKey({
      scope: 'test:register',
      key: '127.0.0.1',
      limit: 2,
      windowMs: 1_000,
      nowMs: 1_001,
    });
    expect(second.limited).toBe(false);
    expect(second.remaining).toBe(0);

    const third = await consumeSharedRateLimitKey({
      scope: 'test:register',
      key: '127.0.0.1',
      limit: 2,
      windowMs: 1_000,
      nowMs: 1_002,
    });
    expect(third.limited).toBe(true);
    expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('resets limits when moving into a new time window', async () => {
    const limited = await consumeSharedRateLimitKey({
      scope: 'test:register',
      key: '203.0.113.5',
      limit: 1,
      windowMs: 5_000,
      nowMs: 10_000,
    });
    expect(limited.limited).toBe(false);

    const blocked = await consumeSharedRateLimitKey({
      scope: 'test:register',
      key: '203.0.113.5',
      limit: 1,
      windowMs: 5_000,
      nowMs: 10_100,
    });
    expect(blocked.limited).toBe(true);

    const nextWindow = await consumeSharedRateLimitKey({
      scope: 'test:register',
      key: '203.0.113.5',
      limit: 1,
      windowMs: 5_000,
      nowMs: 15_001,
    });
    expect(nextWindow.limited).toBe(false);
    expect(nextWindow.remaining).toBe(0);
  });
});
