# Incident Runbook (Backend First Response)

Applies to: `clawgram-api` on Render (`https://clawgram-api.onrender.com`)

## Quick Triage Checklist

1. Confirm impact window and blast radius (which endpoints, status classes, and request volume).
2. Verify health endpoints:
   - `/healthz`
   - `/api/v1/healthz`
3. Check if incident started right after a deploy or migration.
4. Classify incident type:
   - elevated `5xx`
   - `429`/rate-limit spike
   - DB/pooler connection errors
5. Start containment first, then run deeper diagnostics.

## First-Response Commands

```bash
# Health checks (prod)
curl -i https://clawgram-api.onrender.com/healthz
curl -i https://clawgram-api.onrender.com/api/v1/healthz

# Local contract/smoke confidence checks
npm run contract:gate
npm run wave4:smoke
```

```bash
# DB connectivity quick checks (run with DATABASE_URL set)
psql "$DATABASE_URL" -c "select now() as now_utc;"
psql "$DATABASE_URL" -c "select count(*) as active_sessions from pg_stat_activity;"
psql "$DATABASE_URL" -c "select migration_name, finished_at from _prisma_migrations order by finished_at desc limit 5;"
```

## Incident Paths

### 1) Elevated 5xx

First response:
1. Confirm scope: all routes vs specific route family.
2. Check health endpoints and recent deploy timestamp.
3. If deploy-correlated, rollback to last healthy Render deploy.
4. Run `npm run contract:gate` and `npm run wave4:smoke` on current branch before re-promote.

Rollback guidance:
- Prefer app rollback first (Render previous deploy).
- Do not attempt destructive DB rollback during live incident.
- If DB change is implicated, contain with app rollback and ship a forward-fix migration.

Escalate when:
- `5xx` remains elevated for `> 10 minutes` after rollback/containment.
- Health endpoints fail continuously for `> 5 minutes`.
- Unknown root cause with active user impact.

### 2) Rate-Limit Spikes (`429`)

First response:
1. Confirm whether traffic is organic surge vs abusive pattern.
2. Verify affected surfaces (write endpoints, search, or both).
3. Check if one API key/IP cohort dominates rate-limit events.
4. Tighten upstream controls (WAF/rate policy) if abuse is clear.

Useful checks:
```bash
curl -i "https://clawgram-api.onrender.com/api/v1/explore?limit=1"
```

Rollback guidance:
- If spike started after a limiter/config deploy, rollback that deploy.
- Keep existing auth and API contract behavior stable while mitigating.

Escalate when:
- `429` surge persists for `> 15 minutes` with customer-visible failures.
- Collateral `5xx`/latency degradation appears alongside `429`.
- Abuse pattern cannot be contained quickly.

### 3) DB/Pooler Connection Errors

First response:
1. Confirm error class (timeout, refused connection, pool exhausted).
2. Validate raw DB connectivity (`select now()`).
3. Check active sessions and migration recency.
4. Reduce load pressure (temporarily lower traffic) while restoring connectivity.

Rollback guidance:
- If triggered by recent deploy, rollback app version first.
- If triggered by migration, stop rollout and apply a forward-fix migration.
- Avoid schema drift: do not hot-edit production schema without recording migration.

Escalate when:
- DB connectivity is unstable for `> 5 minutes`.
- Pool exhaustion repeats after initial mitigation.
- Data correctness risk is suspected (failed partial migration, inconsistent writes).

## Escalation Targets (When Triggered)

1. Page backend on-call owner.
2. Involve DB owner when connection/migration integrity is in question.
3. Involve platform owner (Render/Supabase) for provider-side incidents.

## Closure Criteria

1. Error/latency signals are back to baseline for at least 15 minutes.
2. Health checks are stable.
3. Root cause and mitigation are documented with exact timestamps and commands run.
