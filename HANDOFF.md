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

---

## A1 API Contract Audit (2026-02-09)

## Summary
- Audited `spec.md`, `openapi.yaml`, and current `src/routes/*` implementation for Wave 0 contract parity.
- Produced a concrete mismatch matrix for endpoint surface, `/api/v1` prefixing, envelope/error-code shape, and mutation status codes.
- Appended web-facing impact notes for contract consumer alignment.

## Changed Files
- `HANDOFF.md`

## Validation Run
- `npm run lint`: fail (`ESLint couldn't find an eslint.config.(js|mjs|cjs) file`; repo currently has `.eslintrc.cjs`)
- `npm run build`: pass

## Contract Notes
- Wave 0 mismatch matrix:

| Area | Spec / Contract Reference | Current Evidence | Gap |
|---|---|---|---|
| `/api/v1` prefix at runtime | `spec.md:169` requires all V1 endpoints under `/api/v1` | `src/routes/agents.ts:16`, `src/routes/agents.ts:47`, `src/routes/explore.ts:15`, `src/routes/health.ts:21`, `src/routes/health.ts:22` are unprefixed; only `src/routes/health.ts:23` is prefixed | Runtime routing is not consistently version-prefixed; clients can call non-versioned paths not allowed by spec |
| Success envelope fields | `spec.md:175` requires `success`, `data`, `request_id` | `src/schemas/common.ts:9`, `src/schemas/common.ts:11`, `src/schemas/common.ts:12` define only `success` + `data`; handlers in `src/routes/agents.ts:32` and `src/routes/explore.ts:31` return no `request_id` | Missing `request_id` in body across successful responses |
| Error envelope fields and machine code | `spec.md:176`, `spec.md:358`, `spec.md:359` require `error`, `code`, optional `hint`, `request_id` with fixed code catalog | `src/schemas/common.ts:3-6` has `error` and optional `hint` only; no `code`, no `request_id`; no route-level error schemas in `src/routes/agents.ts:20`, `src/routes/explore.ts:23`, `src/routes/health.ts:7` | Error contract cannot satisfy locked V1 error taxonomy (e.g. `invalid_api_key`, `validation_error`, `forbidden`, `not_found`) |
| `X-Request-Id` header parity | `spec.md:179` requires mirroring `request_id` in `X-Request-Id` | No explicit request-id response header wiring in `src/server.ts` and no request-id references in `src/**` (`rg` check) | Required request correlation contract is not implemented |
| Cursor pagination shape | `spec.md:521-523` standardizes `next_cursor` + `has_more` | `src/schemas/common.ts:15-18` has `items` + optional `next_cursor`; no `has_more` | Cursor envelope is incomplete vs locked contract |
| Create status semantics | `spec.md:496` requires `201 Created` for creates | `openapi.yaml:19`, `openapi.yaml:121`, `openapi.yaml:139`, `openapi.yaml:157`, `openapi.yaml:221` mark create-style endpoints as `200`; runtime register route uses `200` in `src/routes/agents.ts:21` | Status codes for create operations are inconsistent with locked V1 policy |
| Minimum endpoint surface (implementation) | `spec.md:184-219` defines Wave 0+ minimum endpoints | Implemented routes are only `POST /agents/register` (`src/routes/agents.ts:16`), `GET /agents/{name}` (`src/routes/agents.ts:47`), `GET /explore` (`src/routes/explore.ts:15`), plus health routes (`src/routes/health.ts:21-23`) | Most required endpoints are not implemented yet (`/agents/status`, `/agents/me`, `/feed`, `/posts/*`, `/media/*`, interactions, reporting, search, etc.) |
| Minimum endpoint surface (OpenAPI draft) | `spec.md:184-219` | `openapi.yaml` is missing required paths: `/agents/me/api-key/rotate`, `/agents/me/avatar`, `/agents/{name}/followers`, `/agents/{name}/following`, `/agents/{name}/posts`, `/search`, `/comments/{comment_id}/replies`, `/comments/{comment_id}`, `/comments/{comment_id}/hide`, `/posts/{post_id}/report` | Contract draft is incomplete for web/client generation and Wave planning |
| OpenAPI envelope parity | `spec.md:175-176` envelope is mandatory on every response | `openapi.yaml` success responses reference raw schemas (`Agent`, `Post`, etc.) and do not model `success` / `request_id`; no standardized error envelope models | OpenAPI and runtime envelope contract are both out of sync with spec lock |
| Health route documentation drift | AGENTS deploy baseline requires health checks, but contract artifacts should stay aligned | Runtime has `/health`, `/healthz`, `/api/v1/healthz` (`src/routes/health.ts:21-23`); `openapi.yaml` has no health paths | Doc/runtime drift can break smoke-test or client-expectation automation |

## Cross-Repo Impact
- `clawgram-web` should not generate or lock client types from current `openapi.yaml` yet; endpoint set, envelope shape, and create status codes are still contract-incomplete.
- Web client request/response adapters will need updates once API enforces: `/api/v1`-only routes, mandatory `request_id`, standardized error `code`, and cursor `has_more`.

## Open Risks / Follow-ups
- Fix lint config/tooling mismatch (ESLint v9 expects flat config; repo currently uses `.eslintrc.cjs`) so required lint gate can run in CI/local.
- Execute Wave 0 contract lock implementation in API before parallel web consumption work:
  - enforce `/api/v1` route group
  - add unified response/error envelope with `request_id` + `X-Request-Id`
  - align create endpoints to `201`
  - complete missing required endpoint stubs in `openapi.yaml`
