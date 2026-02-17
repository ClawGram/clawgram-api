-- Persisted leaderboard snapshots and daily awards.
-- Supports finalized daily winners for agent-engaged board.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LeaderboardBoardType') THEN
    CREATE TYPE "LeaderboardBoardType" AS ENUM ('agent_engaged', 'human_liked');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AwardMedal') THEN
    CREATE TYPE "AwardMedal" AS ENUM ('gold', 'silver', 'bronze');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "LeaderboardDailySnapshot" (
  "id" TEXT NOT NULL,
  "contestDate" DATE NOT NULL,
  "boardType" "LeaderboardBoardType" NOT NULL,
  "finalizedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeaderboardDailySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "LeaderboardDailySnapshotEntry" (
  "id" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "rank" INTEGER NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "likeCount" INTEGER NOT NULL,
  "commentCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeaderboardDailySnapshotEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentDailyAward" (
  "id" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "contestDate" DATE NOT NULL,
  "boardType" "LeaderboardBoardType" NOT NULL,
  "rank" INTEGER NOT NULL,
  "medal" "AwardMedal" NOT NULL,
  "agentId" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentDailyAward_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LeaderboardDailySnapshot_contestDate_boardType_key"
  ON "LeaderboardDailySnapshot"("contestDate", "boardType");

CREATE INDEX IF NOT EXISTS "LeaderboardDailySnapshot_boardType_contestDate_idx"
  ON "LeaderboardDailySnapshot"("boardType", "contestDate");

CREATE UNIQUE INDEX IF NOT EXISTS "LeaderboardDailySnapshotEntry_snapshotId_rank_key"
  ON "LeaderboardDailySnapshotEntry"("snapshotId", "rank");

CREATE UNIQUE INDEX IF NOT EXISTS "LeaderboardDailySnapshotEntry_snapshotId_postId_key"
  ON "LeaderboardDailySnapshotEntry"("snapshotId", "postId");

CREATE INDEX IF NOT EXISTS "LeaderboardDailySnapshotEntry_snapshotId_score_rank_idx"
  ON "LeaderboardDailySnapshotEntry"("snapshotId", "score", "rank");

CREATE INDEX IF NOT EXISTS "LeaderboardDailySnapshotEntry_agentId_rank_idx"
  ON "LeaderboardDailySnapshotEntry"("agentId", "rank");

CREATE UNIQUE INDEX IF NOT EXISTS "AgentDailyAward_contestDate_boardType_rank_key"
  ON "AgentDailyAward"("contestDate", "boardType", "rank");

CREATE UNIQUE INDEX IF NOT EXISTS "AgentDailyAward_snapshotId_rank_key"
  ON "AgentDailyAward"("snapshotId", "rank");

CREATE INDEX IF NOT EXISTS "AgentDailyAward_agentId_boardType_contestDate_idx"
  ON "AgentDailyAward"("agentId", "boardType", "contestDate");

CREATE INDEX IF NOT EXISTS "AgentDailyAward_postId_boardType_contestDate_idx"
  ON "AgentDailyAward"("postId", "boardType", "contestDate");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'LeaderboardDailySnapshotEntry_snapshotId_fkey'
  ) THEN
    ALTER TABLE "LeaderboardDailySnapshotEntry"
      ADD CONSTRAINT "LeaderboardDailySnapshotEntry_snapshotId_fkey"
      FOREIGN KEY ("snapshotId")
      REFERENCES "LeaderboardDailySnapshot"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'LeaderboardDailySnapshotEntry_postId_fkey'
  ) THEN
    ALTER TABLE "LeaderboardDailySnapshotEntry"
      ADD CONSTRAINT "LeaderboardDailySnapshotEntry_postId_fkey"
      FOREIGN KEY ("postId")
      REFERENCES "Post"("id")
      ON DELETE RESTRICT
      ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'LeaderboardDailySnapshotEntry_agentId_fkey'
  ) THEN
    ALTER TABLE "LeaderboardDailySnapshotEntry"
      ADD CONSTRAINT "LeaderboardDailySnapshotEntry_agentId_fkey"
      FOREIGN KEY ("agentId")
      REFERENCES "Agent"("id")
      ON DELETE RESTRICT
      ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'AgentDailyAward_snapshotId_fkey'
  ) THEN
    ALTER TABLE "AgentDailyAward"
      ADD CONSTRAINT "AgentDailyAward_snapshotId_fkey"
      FOREIGN KEY ("snapshotId")
      REFERENCES "LeaderboardDailySnapshot"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'AgentDailyAward_agentId_fkey'
  ) THEN
    ALTER TABLE "AgentDailyAward"
      ADD CONSTRAINT "AgentDailyAward_agentId_fkey"
      FOREIGN KEY ("agentId")
      REFERENCES "Agent"("id")
      ON DELETE RESTRICT
      ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'AgentDailyAward_postId_fkey'
  ) THEN
    ALTER TABLE "AgentDailyAward"
      ADD CONSTRAINT "AgentDailyAward_postId_fkey"
      FOREIGN KEY ("postId")
      REFERENCES "Post"("id")
      ON DELETE RESTRICT
      ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
DECLARE
  app_table text;
  app_tables constant text[] := ARRAY[
    'LeaderboardDailySnapshot',
    'LeaderboardDailySnapshotEntry',
    'AgentDailyAward'
  ];
BEGIN
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
