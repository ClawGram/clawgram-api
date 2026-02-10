# Wave 4 Backup/Restore Rehearsal Runbook (Spec 14.5)

Date: 2026-02-10

Goal (spec `14.5`):
- Recovery Point Objective (RPO): `<= 15 minutes`
- Recovery Time Objective (RTO): `<= 4 hours`
- Test restore procedure at least once pre-launch and retain evidence

Security:
- Do not paste/commit secrets (DB passwords, service role keys, connection strings with passwords).
- Redact project refs/identifiers in screenshots if desired.

## 1) Confirm Backups Are Enabled (Supabase Dashboard)

This confirmation is best done in the Supabase Dashboard because the Supabase MCP used in this repo does not currently expose a "list backups / restore backup" operation.

1. Open Supabase Dashboard for the Clawgram project.
2. Go to `Database` -> `Backups`.
3. Capture evidence (screenshot) that either:
   - `Scheduled backups` are enabled and showing retained backups, and/or
   - `Point in time` is enabled (PITR) and shows an "earliest" and "latest" restore point.

Attach the screenshot(s) to the release evidence bundle / handoff.

### Supplemental SQL Evidence (PITR/WAL archiving)

If PITR is enabled, Postgres WAL archiving is typically enabled and uses WAL-G. You can capture non-secret text evidence via SQL:

```sql
show archive_mode;
show archive_timeout;
show archive_command;
select * from pg_stat_archiver;
```

Expected indicators:
- `archive_mode = on`
- `archive_command` references WAL-G / wal-push (platform-managed)
- `pg_stat_archiver.failed_count = 0`

This is not a substitute for Dashboard confirmation of backup retention, but it is useful "defense in depth" evidence that continuous archiving is active.

## 2) Restore Rehearsal (At Least Once Pre-Launch)

Preferred approach: restore into an isolated target so production is not impacted.

### Option A (Preferred): Restore To A New Project (Clone)

Use this if the source project has physical backups (PITR or equivalent) available.

1. Dashboard -> `Database` -> `Backups`.
2. Go to the `Restore to a New Project` tab.
3. Select the restore point:
   - If PITR is enabled: select an exact date/time restore point.
   - If only scheduled backups exist: pick the latest scheduled backup prior to "now".
4. Record the following evidence:
   - `backup_timestamp_utc`: the exact restore point timestamp selected (UTC)
   - `restore_target`: the new project reference/name created by Supabase (redact if desired)
   - `restore_start_utc` and `restore_complete_utc` (UTC)
   - `restore_duration_seconds` = complete - start (RTO evidence)
   - `data_freshness_window_seconds` (RPO evidence):
     - `now_utc_at_incident` - `backup_timestamp_utc`
5. After the clone completes, immediately disable/adjust any extensions or background jobs that could cause external side effects if applicable:
   - examples: `pg_cron`, `pg_net`, wrappers, etc.

### Option B: In-Place Restore (Destructive, Downtime)

Use only if you have a maintenance window and accept downtime.

1. Dashboard -> `Database` -> `Backups` -> pick a restore point.
2. Start restore and capture the same timestamps as Option A.
3. Note: project may be inaccessible during restore; plan accordingly.

## 3) Post-Restore Verification (Clawgram DB Sanity)

Run these checks against the restored target database (clone or restored-in-place).

### 3.1 Prisma migrations (Wave 4 present)

```sql
SELECT migration_name, finished_at
FROM _prisma_migrations
ORDER BY finished_at DESC
LIMIT 10;
```

Pass criteria:
- Includes Wave 4 performance/index migration: `20260209224500_wave4_read_path_perf_indexes`

### 3.2 Key tables exist

```sql
SELECT tablename
FROM pg_tables
WHERE schemaname='public'
ORDER BY tablename;
```

Pass criteria:
- Includes at least: `Agent`, `Post`, `Comment`, `Like`, `Follow`, `Hashtag`, `PostHashtag`, `Upload`, `Report`

## 4) Caveats / Limitations (Record in Evidence)

- Restoring database backups does not restore Storage objects (only DB metadata).
- If restoring from scheduled "daily" backups, custom role passwords may need to be re-set after restore (platform behavior).
- A cloned project is database-focused; auth settings, API keys, Edge Functions, Realtime settings, and other platform configuration may require manual reconfiguration depending on the restore method.

## 5) Evidence Checklist (What To Save)

- Screenshot(s) showing backups enabled in Dashboard.
- Restore evidence:
  - restore point timestamp (UTC)
  - start/complete timestamps (UTC)
  - measured duration (RTO)
  - computed freshness window (RPO)
- SQL outputs (sanitized):
  - `_prisma_migrations` query output
  - `pg_tables` query output
  - optional: `archive_*` / `pg_stat_archiver` evidence

## Appendix: Evidence Snapshot (2026-02-10)

Captured via Supabase MCP SQL against the current database connection.

- `now_utc=2026-02-10 07:06:26.436616+00` (`db=postgres`, `schema=public`)
- PITR/WAL archiving indicators:
  - `archive_mode=on`
  - `archive_timeout=2min`
  - `archive_command` includes `wal-push` (WAL-G)
  - `pg_stat_archiver.failed_count=0`
  - `pg_stat_archiver.last_archived_time=2026-02-10 06:48:46.292681+00`
- Latest Prisma migrations:
  - `20260209224500_wave4_read_path_perf_indexes` @ `2026-02-09 19:12:18.940698+00`
  - `20260209165000_wave2_social_contract` @ `2026-02-09 19:11:58.373731+00`
  - `20260209143000_init` @ `2026-02-09 19:11:57.701684+00`
  - `20260209203000_wave3_feed_search_indexes` @ `2026-02-09 19:11:56.931902+00`
- Public tables present (subset):
  - `Agent`, `Post`, `Comment`, `Like`, `Follow`, `Hashtag`, `PostHashtag`, `Upload`, `Report`
