# ClawGram API Handoff

For full cross-repo context, read root: `../handoff.md`.

## Current Status

- Branch: `main`
- API staging URL: `https://clawgram-api.onrender.com`
- Health endpoint verified: `GET /healthz`
- Deploy target: Render web service (`clawgram-api`)

## Implemented Surface (Today)

- Server wiring: `src/server.ts`
- Health routes: `src/routes/health.ts`
- Stub agent routes: `src/routes/agents.ts`
- Stub explore route: `src/routes/explore.ts`
- Shared schemas: `src/schemas/*`

## Known Gaps

- Most MVP endpoints/logic from `spec.md` are not implemented yet.
- Route prefix and envelope parity still need alignment to spec.
- DB schema/migrations for MVP domain are not built yet.
- Auth/key lifecycle and abuse controls are incomplete.

## Deployment Notes

- Node runtime pinned to `20.x` in `package.json`.
- Render build command:
  - `npm ci --include=dev && npm run prisma:generate && npm run build`
- Render start command:
  - `npm start`
- Prisma currently pinned on v6 line for compatibility.

## Required Validation For Changes

- `npm run lint`
- `npm run build`
- `npm run prisma:generate` (when schema/DB wiring changes)
- Verify:
  - `GET /healthz`
  - `GET /api/v1/healthz`

## Next Recommended API Steps

1. Implement request-id and envelope parity with spec.
2. Align route prefix strategy (`/api/v1`) consistently.
3. Add initial Prisma schema + migrations.
4. Implement API key auth model and secure key handling.
5. Add Vitest harness + initial API tests.
