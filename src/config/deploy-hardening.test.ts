import { describe, expect, it } from 'vitest';
import { getRequiredCorsOrigins, shouldEnableApiDocs, validateProductionConfig } from './deploy-hardening';

const REQUIRED_ORIGINS = getRequiredCorsOrigins();

function makeEnv(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://user:pass@host:5432/postgres',
    CORS_ALLOWED_ORIGINS: `${REQUIRED_ORIGINS[0]},${REQUIRED_ORIGINS[1]}`,
    CLAWGRAM_UPLOAD_BASE_URL: 'https://clawgram-api.onrender.com/uploads',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_STORAGE_BUCKET: 'public-images',
    SUPABASE_SECRET_KEY: 'secret-key',
    API_KEY_PEPPER: 'api-pepper-production',
    OWNER_TOKEN_PEPPER: 'owner-pepper-production',
  };
}

describe('validateProductionConfig', () => {
  it('passes for a valid production env', () => {
    const result = validateProductionConfig(makeEnv());
    expect(result.errors).toEqual([]);
  });

  it('fails when canonical clawgram origins are missing', () => {
    const env = makeEnv();
    env.CORS_ALLOWED_ORIGINS = 'https://www.clawgram.org';
    const result = validateProductionConfig(env);
    expect(result.errors.some((error) => error.includes('https://clawgram.org'))).toBe(true);
  });

  it('fails when supabase admin key is missing', () => {
    const env = makeEnv();
    delete env.SUPABASE_SECRET_KEY;
    const result = validateProductionConfig(env);
    expect(result.errors.some((error) => error.includes('Missing Supabase admin key'))).toBe(true);
  });

  it('fails when development pepper defaults are used', () => {
    const env = makeEnv();
    env.API_KEY_PEPPER = 'clawgram_dev_pepper';
    env.OWNER_TOKEN_PEPPER = 'clawgram_owner_dev_pepper';
    const result = validateProductionConfig(env);
    expect(result.errors.some((error) => error.includes('API_KEY_PEPPER'))).toBe(true);
    expect(result.errors.some((error) => error.includes('OWNER_TOKEN_PEPPER'))).toBe(true);
  });

  it('warns when localhost origin is included in production CORS list', () => {
    const env = makeEnv();
    env.CORS_ALLOWED_ORIGINS = `${REQUIRED_ORIGINS[0]},${REQUIRED_ORIGINS[1]},http://localhost:5173`;
    const result = validateProductionConfig(env);
    expect(result.warnings.some((warning) => warning.includes('localhost'))).toBe(true);
  });

  it('keeps API docs disabled by default in production', () => {
    expect(shouldEnableApiDocs(makeEnv())).toBe(false);
  });

  it('allows API docs in production only with explicit enable flag', () => {
    const env = makeEnv();
    env.ENABLE_API_DOCS = 'true';
    expect(shouldEnableApiDocs(env)).toBe(true);
    expect(validateProductionConfig(env).warnings.some((warning) => warning.includes('API docs'))).toBe(
      true,
    );
  });

  it('enables API docs by default in non-production envs', () => {
    const env = makeEnv();
    env.NODE_ENV = 'development';
    delete env.ENABLE_API_DOCS;
    expect(shouldEnableApiDocs(env)).toBe(true);
  });
});
