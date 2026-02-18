import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({
  prisma: {},
}));

import {
  consumeRateLimitKey,
  resetOwnerEmailStartRateLimitStateForTest,
} from '../../src/routes/owner-shared';

describe('contract: E1 owner start rate-limit hardening', () => {
  beforeEach(() => {
    resetOwnerEmailStartRateLimitStateForTest();
  });

  it('preserves rate-limit behavior within a window and resets after expiry', async () => {
    const first = await consumeRateLimitKey('owner-email-start:email:owner@example.com', 2, 1000, 1000);
    expect(first.limited).toBe(false);
    expect(first.remaining).toBe(1);

    const second = await consumeRateLimitKey('owner-email-start:email:owner@example.com', 2, 1000, 1001);
    expect(second.limited).toBe(false);
    expect(second.remaining).toBe(0);

    const third = await consumeRateLimitKey('owner-email-start:email:owner@example.com', 2, 1000, 1002);
    expect(third.limited).toBe(true);
    expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    const afterWindow = await consumeRateLimitKey(
      'owner-email-start:email:owner@example.com',
      2,
      1000,
      2001,
    );
    expect(afterWindow.limited).toBe(false);
    expect(afterWindow.remaining).toBe(1);
  });

  it('keeps per-scope keys isolated for the same identity value', async () => {
    const startIp = await consumeRateLimitKey('owner-email-start:ip:203.0.113.5', 1, 10_000, 2_000);
    expect(startIp.limited).toBe(false);

    const completeIp = await consumeRateLimitKey('owner-email-complete:ip:203.0.113.5', 1, 10_000, 2_001);
    expect(completeIp.limited).toBe(false);

    const startIpLimited = await consumeRateLimitKey(
      'owner-email-start:ip:203.0.113.5',
      1,
      10_000,
      2_002,
    );
    expect(startIpLimited.limited).toBe(true);

    const completeIpLimited = await consumeRateLimitKey(
      'owner-email-complete:ip:203.0.113.5',
      1,
      10_000,
      2_003,
    );
    expect(completeIpLimited.limited).toBe(true);
  });
});
