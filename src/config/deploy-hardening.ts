import { normalizeOrigin } from '../http/normalize';

const REQUIRED_CORS_ORIGINS = ['https://www.clawgram.org', 'https://clawgram.org'] as const;

const REQUIRED_PRODUCTION_ENV_KEYS = [
  'DATABASE_URL',
  'CORS_ALLOWED_ORIGINS',
  'CLAWGRAM_UPLOAD_BASE_URL',
  'SUPABASE_URL',
  'SUPABASE_STORAGE_BUCKET',
  'API_KEY_PEPPER',
  'OWNER_TOKEN_PEPPER',
] as const;

const DEV_API_KEY_PEPPER = 'clawgram_dev_pepper';
const DEV_OWNER_TOKEN_PEPPER = 'clawgram_owner_dev_pepper';

export type ProductionConfigValidationResult = {
  errors: string[];
  warnings: string[];
};

type EnvMap = Record<string, string | undefined>;

type ValidationLogger = {
  warn: (message?: unknown, ...optionalParams: unknown[]) => void;
  error: (message?: unknown, ...optionalParams: unknown[]) => void;
};

function readTrimmed(env: EnvMap, key: string): string | null {
  const value = env[key];
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseCorsAllowlist(rawList: string | null): { origins: Set<string>; invalidTokens: string[] } {
  const origins = new Set<string>();
  const invalidTokens: string[] = [];

  if (!rawList) {
    return { origins, invalidTokens };
  }

  for (const token of rawList.split(',')) {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const normalized = normalizeOrigin(trimmed);
    if (!normalized) {
      invalidTokens.push(trimmed);
      continue;
    }
    origins.add(normalized);
  }

  return { origins, invalidTokens };
}

function isProductionEnv(env: EnvMap): boolean {
  return (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

function parseOptionalBoolean(raw: string | undefined): boolean | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return null;
}

export function shouldEnableApiDocs(env: EnvMap): boolean {
  const explicit = parseOptionalBoolean(env.ENABLE_API_DOCS);
  if (isProductionEnv(env)) {
    return explicit === true;
  }

  if (explicit === false) {
    return false;
  }
  return true;
}

export function getRequiredCorsOrigins(): readonly string[] {
  return REQUIRED_CORS_ORIGINS;
}

export function validateProductionConfig(env: EnvMap): ProductionConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const key of REQUIRED_PRODUCTION_ENV_KEYS) {
    if (!readTrimmed(env, key)) {
      errors.push(`Missing required production env var: ${key}`);
    }
  }

  const supabaseSecretKey = readTrimmed(env, 'SUPABASE_SECRET_KEY');
  const supabaseServiceRoleKey = readTrimmed(env, 'SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseSecretKey && !supabaseServiceRoleKey) {
    errors.push(
      'Missing Supabase admin key: set SUPABASE_SECRET_KEY (preferred) or SUPABASE_SERVICE_ROLE_KEY',
    );
  }
  if (supabaseSecretKey && supabaseServiceRoleKey) {
    warnings.push('Both SUPABASE_SECRET_KEY and SUPABASE_SERVICE_ROLE_KEY are set; keep only one canonical key');
  }

  const apiKeyPepper = readTrimmed(env, 'API_KEY_PEPPER');
  if (apiKeyPepper === DEV_API_KEY_PEPPER) {
    errors.push('API_KEY_PEPPER is using insecure development default');
  }

  const ownerTokenPepper = readTrimmed(env, 'OWNER_TOKEN_PEPPER');
  if (ownerTokenPepper === DEV_OWNER_TOKEN_PEPPER) {
    errors.push('OWNER_TOKEN_PEPPER is using insecure development default');
  }

  const corsAllowlist = parseCorsAllowlist(readTrimmed(env, 'CORS_ALLOWED_ORIGINS'));
  if (corsAllowlist.invalidTokens.length > 0) {
    errors.push(`CORS_ALLOWED_ORIGINS contains invalid origins: ${corsAllowlist.invalidTokens.join(', ')}`);
  }

  for (const requiredOrigin of REQUIRED_CORS_ORIGINS) {
    if (!corsAllowlist.origins.has(requiredOrigin)) {
      errors.push(`CORS_ALLOWED_ORIGINS must include ${requiredOrigin}`);
    }
  }

  const localOrigins = [...corsAllowlist.origins].filter((origin) => origin.includes('localhost'));
  if (localOrigins.length > 0) {
    warnings.push(`Production CORS allowlist still includes localhost origins: ${localOrigins.join(', ')}`);
  }

  if (shouldEnableApiDocs(env)) {
    warnings.push('ENABLE_API_DOCS is enabled in production; API docs will be publicly exposed');
  }

  return { errors, warnings };
}

export function enforceProductionConfigOrThrow(
  env: EnvMap,
  logger: ValidationLogger = console,
) {
  if (!isProductionEnv(env)) {
    return;
  }

  const validation = validateProductionConfig(env);
  for (const warning of validation.warnings) {
    logger.warn(`[config-warning] ${warning}`);
  }

  if (validation.errors.length === 0) {
    return;
  }

  for (const error of validation.errors) {
    logger.error(`[config-error] ${error}`);
  }

  throw new Error(`Production config validation failed (${validation.errors.length} errors)`);
}
