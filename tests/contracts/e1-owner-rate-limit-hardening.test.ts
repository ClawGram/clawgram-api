import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumeRateLimitKey,
  ownerEmailStartRateLimitBucketCountForTest,
  OWNER_EMAIL_START_BUCKET_MAX_KEYS,
  OWNER_EMAIL_START_BUCKET_PRUNE_INTERVAL_MS,
  resetOwnerEmailStartRateLimitStateForTest,
} from '../../src/routes/owner-shared';

describe('contract: E1 owner start rate-limit hardening', () => {
  beforeEach(() => {
    resetOwnerEmailStartRateLimitStateForTest();
  });

  it('preserves rate-limit behavior within a window and resets after expiry', () => {
    const first = consumeRateLimitKey('owner-email-start:email:owner@example.com', 2, 1000, 1000);
    expect(first.limited).toBe(false);
    expect(first.remaining).toBe(1);

    const second = consumeRateLimitKey('owner-email-start:email:owner@example.com', 2, 1000, 1001);
    expect(second.limited).toBe(false);
    expect(second.remaining).toBe(0);

    const third = consumeRateLimitKey('owner-email-start:email:owner@example.com', 2, 1000, 1002);
    expect(third.limited).toBe(true);
    expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    const afterWindow = consumeRateLimitKey('owner-email-start:email:owner@example.com', 2, 1000, 2001);
    expect(afterWindow.limited).toBe(false);
    expect(afterWindow.remaining).toBe(1);
  });

  it('caps stored buckets to avoid unbounded key growth', () => {
    const totalKeys = OWNER_EMAIL_START_BUCKET_MAX_KEYS + 25;

    for (let index = 0; index < totalKeys; index += 1) {
      consumeRateLimitKey(`owner-email-start:ip:10.0.0.${index}`, 1, 60_000, 50_000);
    }

    expect(ownerEmailStartRateLimitBucketCountForTest()).toBeLessThanOrEqual(
      OWNER_EMAIL_START_BUCKET_MAX_KEYS,
    );

    const oldestRecheck = consumeRateLimitKey('owner-email-start:ip:10.0.0.0', 1, 60_000, 50_000);
    expect(oldestRecheck.limited).toBe(false);
  });

  it('prunes expired buckets on scheduled cleanup window', () => {
    consumeRateLimitKey('owner-email-start:email:expired@example.com', 1, 10, 1_000);
    expect(ownerEmailStartRateLimitBucketCountForTest()).toBe(1);

    consumeRateLimitKey(
      'owner-email-start:email:active@example.com',
      1,
      60_000,
      1_000 + OWNER_EMAIL_START_BUCKET_PRUNE_INTERVAL_MS + 1,
    );

    expect(ownerEmailStartRateLimitBucketCountForTest()).toBe(1);
  });
});
