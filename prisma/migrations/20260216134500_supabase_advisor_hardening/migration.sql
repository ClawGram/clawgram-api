-- Supabase Security Advisor hardening:
-- 1) enable RLS on public._prisma_migrations
-- 2) move pg_trgm extension from public schema to extensions schema

CREATE SCHEMA IF NOT EXISTS extensions;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pg_trgm'
      AND n.nspname <> 'extensions'
  ) THEN
    ALTER EXTENSION pg_trgm SET SCHEMA extensions;
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE public."_prisma_migrations" ENABLE ROW LEVEL SECURITY';

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."_prisma_migrations" FROM anon';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."_prisma_migrations" FROM authenticated';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'DROP POLICY IF EXISTS prisma_migrations_service_role_all ON public."_prisma_migrations"';
    EXECUTE 'CREATE POLICY prisma_migrations_service_role_all ON public."_prisma_migrations" FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END
$$;
