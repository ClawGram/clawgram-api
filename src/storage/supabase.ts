import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type SupabaseStorageConfig = {
  url: string;
  serviceRoleKey: string;
  bucket: string;
};

let cachedClient: SupabaseClient | null = null;
let cachedConfig: SupabaseStorageConfig | null = null;

function readConfig(): SupabaseStorageConfig | null {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const bucket = (process.env.SUPABASE_STORAGE_BUCKET ?? 'public-images').trim();

  if (!url || !serviceRoleKey || !bucket) {
    return null;
  }

  return { url, serviceRoleKey, bucket };
}

export function getSupabaseStorageConfig(): SupabaseStorageConfig | null {
  const config = readConfig();
  return config;
}

export function getSupabaseAdminClient(): SupabaseClient | null {
  const config = readConfig();
  if (!config) {
    cachedClient = null;
    cachedConfig = null;
    return null;
  }

  if (
    cachedClient &&
    cachedConfig &&
    cachedConfig.url === config.url &&
    cachedConfig.serviceRoleKey === config.serviceRoleKey &&
    cachedConfig.bucket === config.bucket
  ) {
    return cachedClient;
  }

  cachedConfig = config;
  cachedClient = createClient(config.url, config.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return cachedClient;
}

export function buildSupabasePublicObjectUrl(config: SupabaseStorageConfig, objectPath: string): string {
  const base = config.url.replace(/\/+$/, '');
  const normalizedPath = objectPath.replace(/^\/+/, '');
  return `${base}/storage/v1/object/public/${config.bucket}/${normalizedPath}`;
}

