import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function isProductionEnv(env: TrustProxyEnv): boolean {
  return (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

function parseExplicitTrustProxy(rawValue: string): boolean | number | null {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }

  if (/^\d+$/.test(trimmed)) {
    const hops = Number.parseInt(trimmed, 10);
    if (Number.isFinite(hops) && hops >= 1) {
      return hops;
    }
  }

  return null;
}

type TrustProxyEnv = {
  NODE_ENV?: string;
  TRUST_PROXY?: string;
};

export function resolveTrustProxySetting(env: TrustProxyEnv): boolean | number {
  const explicitValue = parseExplicitTrustProxy(env.TRUST_PROXY ?? '');
  if (explicitValue !== null) {
    return explicitValue;
  }
  return isProductionEnv(env);
}

function stripIpv6Prefix(candidate: string): string {
  const normalized = candidate.toLowerCase();
  if (!normalized.startsWith('::ffff:')) {
    return candidate;
  }
  return candidate.slice(7);
}

function extractBareIp(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return '';
  }

  // Defensive split in case a proxy chain leaks into the value.
  const firstToken = trimmed.split(',')[0]?.trim() ?? '';
  if (!firstToken) {
    return '';
  }

  const bracketedIpv6Match = firstToken.match(/^\[([^[\]]+)\](?::\d+)?$/);
  if (bracketedIpv6Match) {
    return bracketedIpv6Match[1];
  }

  const mappedIpv4 = stripIpv6Prefix(firstToken);
  const ipv4WithPortMatch = mappedIpv4.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4WithPortMatch) {
    return ipv4WithPortMatch[1];
  }

  return mappedIpv4;
}

export function normalizeClientIp(rawValue: string | null | undefined): string | null {
  if (typeof rawValue !== 'string') {
    return null;
  }

  const candidate = extractBareIp(rawValue);
  if (!candidate) {
    return null;
  }

  const version = isIP(candidate);
  if (version === 0) {
    return null;
  }

  return version === 6 ? candidate.toLowerCase() : candidate;
}

export function resolveClientIpRateLimitKey(request: FastifyRequest): string {
  return normalizeClientIp(request.ip) ?? 'invalid-client-ip';
}
