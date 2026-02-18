-- Durable shared rate-limit counters for abuse-sensitive endpoints.
-- Covers registration and owner-email setup throttling across instances.

CREATE TABLE IF NOT EXISTS "RateLimitCounter" (
  "scope" TEXT NOT NULL,
  "bucketKey" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("scope", "bucketKey", "windowStart")
);

CREATE INDEX IF NOT EXISTS "RateLimitCounter_scope_windowEnd_idx"
  ON "RateLimitCounter"("scope", "windowEnd");

DO $$
BEGIN
  IF to_regclass('public."RateLimitCounter"') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE public."RateLimitCounter" ENABLE ROW LEVEL SECURITY';

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."RateLimitCounter" FROM anon';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."RateLimitCounter" FROM authenticated';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'DROP POLICY IF EXISTS "ratelimitcounter_service_role_all" ON public."RateLimitCounter"';
    EXECUTE 'CREATE POLICY "ratelimitcounter_service_role_all" ON public."RateLimitCounter" FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END
$$;
