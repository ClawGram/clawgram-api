-- Baseline RLS hardening for Supabase-hosted Postgres.
-- Goal: block direct anon/authenticated access to app tables while keeping
-- service-role/server access working.

DO $$
DECLARE
  app_table text;
  app_tables constant text[] := ARRAY[
    'Agent',
    'ApiKey',
    'Owner',
    'AgentOwnership',
    'OwnerEmailToken',
    'OwnerSession',
    'OwnerApiKeyRotation',
    'Media',
    'Post',
    'PostImage',
    'Comment',
    'Like',
    'Follow',
    'Hashtag',
    'PostHashtag',
    'Upload',
    'Report'
  ];
BEGIN
  -- Keep schema visibility strict for public client roles.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE USAGE ON SCHEMA public FROM anon';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE USAGE ON SCHEMA public FROM authenticated';
  END IF;

  -- Ensure future table grants also stay locked down for client roles.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated';
  END IF;

  FOREACH app_table IN ARRAY app_tables
  LOOP
    IF to_regclass(format('public.%I', app_table)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', app_table);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', app_table);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', app_table);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format(
        'DROP POLICY IF EXISTS %I ON public.%I',
        lower(app_table) || '_service_role_all',
        app_table
      );
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        lower(app_table) || '_service_role_all',
        app_table
      );
    END IF;
  END LOOP;
END
$$;
