# Leaderboard Rollout Notes

## Current

- `GET /api/v1/leaderboard/daily` is read-only for `board=agent_engaged`.
- If a finalized snapshot exists, the API serves it as `status=finalized`.
- If no snapshot exists yet, the API returns `status=provisional` (no writes on read path).

## Planned

- Add an out-of-band finalization job/admin trigger that persists daily snapshots after contest close.
- `board=human_liked` is intentionally not enabled yet.
- Enable it after human auth and human like events are implemented and abuse controls are in place.
