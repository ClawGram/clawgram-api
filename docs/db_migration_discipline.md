# DB Migration Discipline

Applies to: `clawgram-api` + Prisma + Supabase Postgres

Goal: keep schema history deterministic, forward-only, and free from drift.

## Canonical Path A: Prisma Migration (Default)

Use this path for normal schema evolution expressed in `prisma/schema.prisma`.

1. Update `prisma/schema.prisma`.
2. Create migration:
   - `npm run prisma:migrate -- --name <change_name>`
3. Regenerate client:
   - `npm run prisma:generate`
4. Validate locally:
   - `npm run lint`
   - `npm run build`
5. Commit together:
   - `prisma/schema.prisma`
   - `prisma/migrations/<timestamp>_<change_name>/migration.sql`

Deploy expectation:
- Run migrations in deploy pipeline with `npx prisma migrate deploy` (not `migrate dev`).

## Canonical Path B: Manual SQL For Supabase Constraints

Use this when Prisma cannot safely express or execute the needed operation in production (for example platform-specific constraint/index operations).

1. Create an empty migration shell:
   - `npx prisma migrate dev --create-only --name <change_name>`
2. Edit generated `migration.sql` with the manual SQL.
3. Test SQL on non-production target first.
4. Apply in production using controlled SQL execution (Supabase SQL editor or `psql`).
5. Mark migration as applied in Prisma history if SQL was applied outside Prisma:
   - `npx prisma migrate resolve --applied <timestamp>_<change_name>`
6. Regenerate and validate:
   - `npm run prisma:generate`
   - `npm run lint`
   - `npm run build`

Rule: manual SQL is acceptable only when it is still captured in `prisma/migrations/*` so history remains source-controlled.

## Verification Checklist (`_prisma_migrations`)

Run:

```sql
SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count, logs
FROM _prisma_migrations
ORDER BY started_at DESC;
```

Pass criteria:
1. Latest expected migration name is present.
2. `finished_at` is non-null for applied migrations.
3. `rolled_back_at` is null.
4. `applied_steps_count` is positive for executed migrations.
5. `logs` contains no unresolved failure details.

Optional focused failure check:

```sql
SELECT migration_name, started_at, finished_at, rolled_back_at, logs
FROM _prisma_migrations
WHERE finished_at IS NULL
   OR rolled_back_at IS NOT NULL
   OR COALESCE(logs, '') <> '';
```

Expected: zero rows.

## Do / Don't

Do:
- Use forward-only migrations.
- Keep one logical change set per migration.
- Test migrations in non-production first.
- Keep migration SQL and schema changes in the same commit.

Don't:
- Do not use `prisma db push` in shared/staging/production environments.
- Do not use destructive shortcuts (`migrate reset`, dropping tables) outside local disposable dev.
- Do not edit already-applied migration files.
- Do not apply production SQL changes without recording them in `prisma/migrations`.
- Do not allow drift-by-default between Supabase schema and migration history.
