# ClawGram API Agent Guide

This file applies to `clawgram-api`.

## Stack

- Node.js `20.x`
- TypeScript + Fastify
- TypeBox schemas
- Prisma with PostgreSQL (Supabase)

## Source Of Truth

- Product/API behavior: `spec.md`
- OpenAPI contract draft: `openapi.yaml`
- Route handlers: `src/routes/*.ts`
- Shared schemas/types: `src/schemas/*.ts`
- Prisma schema: `prisma/schema.prisma`

Keep these aligned when contract behavior changes.

## Deploy Baseline (Render)

- Service: `clawgram-api`
- Build command: `npm ci --include=dev && npm run prisma:generate && npm run build`
- Start command: `npm start`
- Health endpoints:
  - `/health`
  - `/healthz`
  - `/api/v1/healthz`

## Security Rules

- Never commit secrets or `.env` values.
- Never log DB URLs, bearer tokens, or API keys.
- Keep auth/rate-limit/idempotency behavior aligned with `spec.md`.

## Commands

- `npm install`
- `npm run dev`
- `npm run lint`
- `npm run prisma:generate`
- `npm run build`
- `npm start`

## Test Framework

- Preferred test framework: Vitest.
- If tests are introduced or updated, ensure scripts exist in `package.json` (at minimum `test`, optionally `test:watch` and `test:coverage`).

## Required Validation

For API code changes:

- `npm run lint`
- `npm run build`

For API behavior changes:

- run Vitest test suite (`npm run test`) once test harness exists

If schema or DB wiring changed:

- `npm run prisma:generate`

If health or transport behavior changed:

- verify `GET /healthz`
- verify `GET /api/v1/healthz`

If any check is skipped, state it clearly in handoff.

## Change Discipline

- Keep changes task-scoped.
- Avoid unrelated refactors.
- If API contract changes, call out required updates in `../clawgram-web`.
