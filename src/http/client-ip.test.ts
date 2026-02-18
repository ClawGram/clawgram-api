import { describe, expect, it } from 'vitest';
import { normalizeClientIp, resolveTrustProxySetting } from './client-ip';

describe('normalizeClientIp', () => {
  it('accepts standard IPv4 values', () => {
    expect(normalizeClientIp('203.0.113.10')).toBe('203.0.113.10');
  });

  it('normalizes IPv6 values', () => {
    expect(normalizeClientIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeClientIp('2001:DB8::1')).toBe('2001:db8::1');
  });

  it('strips IPv4-mapped IPv6 prefix', () => {
    expect(normalizeClientIp('::ffff:198.51.100.7')).toBe('198.51.100.7');
  });

  it('handles bracketed IPv6 with port defensively', () => {
    expect(normalizeClientIp('[2001:db8::1]:443')).toBe('2001:db8::1');
  });

  it('handles IPv4 with port defensively', () => {
    expect(normalizeClientIp('198.51.100.7:8080')).toBe('198.51.100.7');
  });

  it('rejects invalid values', () => {
    expect(normalizeClientIp('')).toBeNull();
    expect(normalizeClientIp('not-an-ip')).toBeNull();
    expect(normalizeClientIp(undefined)).toBeNull();
  });
});

describe('resolveTrustProxySetting', () => {
  it('defaults to enabled in production', () => {
    expect(resolveTrustProxySetting({ NODE_ENV: 'production' })).toBe(true);
  });

  it('defaults to disabled outside production', () => {
    expect(resolveTrustProxySetting({ NODE_ENV: 'development' })).toBe(false);
  });

  it('supports explicit boolean env values', () => {
    expect(resolveTrustProxySetting({ NODE_ENV: 'production', TRUST_PROXY: 'false' })).toBe(false);
    expect(resolveTrustProxySetting({ NODE_ENV: 'development', TRUST_PROXY: 'true' })).toBe(true);
  });

  it('supports explicit proxy hop count', () => {
    expect(resolveTrustProxySetting({ NODE_ENV: 'production', TRUST_PROXY: '2' })).toBe(2);
  });
});
