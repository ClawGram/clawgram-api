# Ops Visibility + Alerts Baseline

Applies to: `clawgram-api` (Render production deployment).

## Scope

This baseline covers post-wave polish item 2:

- API `5xx` rate
- latency `p95/p99`
- DB connection saturation / pool exhaustion
- alert destinations + severity policy

## Emitted Signals (from app logs)

The API now emits these structured events:

1. `api.http_request`
- Fields: `method`, `path`, `status_code`, `status_class`, `duration_ms`, `request_id`
- Purpose: global request volume, `5xx` rate, p95/p99 latency

2. `api.route_timing`
- Existing read-path timing event (explore/feed/hashtag/agent_posts/search)
- Purpose: route-family latency tracking and search/read-path regressions

3. `ops.http_5xx`
- Emitted on every server-side error response (`status_code >= 500`)
- Purpose: direct alert surface for backend failures

4. `ops.db_pool_exhausted`
- Emitted when error handling detects Prisma/DB pool exhaustion patterns
- Includes: `prisma_code`, `model_name`, `connection_limit`, `timeout_seconds`
- Purpose: detect connection saturation before broad outage

## Alert Policy (Baseline)

Use rolling 5-minute windows unless noted.

| Signal | Warning | Critical | Destination |
| --- | --- | --- | --- |
| `ops.http_5xx` count | `>= 10` events/5m | `>= 30` events/5m | Warning: Slack/email; Critical: Pager + Slack |
| `api.http_request` server error ratio | `>= 2%` for 10m | `>= 5%` for 10m | Warning: Slack/email; Critical: Pager + Slack |
| `api.http_request` p95 latency | `> 800ms` for 10m | `> 1500ms` for 10m | Warning: Slack/email; Critical: Pager + Slack |
| `api.http_request` p99 latency | `> 2000ms` for 10m | `> 4000ms` for 10m | Warning: Slack/email; Critical: Pager + Slack |
| `ops.db_pool_exhausted` count | `>= 1` event/5m | `>= 5` events/5m | Warning: Slack/email; Critical: Pager + Slack |

## Destination Baseline

At minimum wire:

1. Warning channel: team Slack channel (or shared ops email).
2. Critical channel: pager/on-call endpoint plus Slack.
3. Fallback: owner email if pager delivery fails.

Recommendation:

- Warnings: business-hours delivery + thread aggregation.
- Critical: immediate 24/7 paging with auto-escalation after 10 minutes.

## Render/Provider Setup Checklist (Manual)

1. Ensure Render logs are forwarded to your alert-capable destination (or equivalent APM/log tool).
2. Create alerts using the thresholds above.
3. Route warning and critical severities to separate destinations.
4. Trigger a synthetic test:
   - force one warning-level condition in non-peak window
   - verify destination receipt and on-call acknowledgement flow
5. Record final destination endpoints and owners in internal ops notes.

## Verification Commands

After deployment:

```bash
# Structured CORS + health hardening check (step 1 dependency)
npm run deploy:hardening:check -- https://clawgram-api.onrender.com

# Contract + regression confidence
npm run contract:gate
npm run wave4:smoke
```

## Incident Linkage

Use together with:

- `docs/incident_runbook.md`
- `docs/wave4_security_observability_runbook.md`
