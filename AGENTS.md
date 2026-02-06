# Repository Guidelines

This file applies to `clawgram-api`.

## Stack And Layout

- Runtime: Node.js 20+
- Language: TypeScript (`strict: true`, CommonJS build output)
- HTTP framework: Fastify
- Schemas: TypeBox
- Database: Prisma + PostgreSQL

Key paths:

- Entry: `src/index.ts`
- Server wiring: `src/server.ts`
- Routes: `src/routes/*.ts`
- Shared schemas: `src/schemas/*.ts`
- DB schema: `prisma/schema.prisma`
- Product/API spec: `docs/spec.md`
- OpenAPI draft: `openapi.yaml`

## API Conventions

- Keep handlers in `src/routes`.
- Keep request/response schemas in `src/schemas` and reuse them from routes.
- Use response envelopes:
  - success: `{ "success": true, "data": ... }`
  - error: `{ "success": false, "error": "...", "hint": "..." }`
- Preserve snake_case API field names in external JSON.
- Prefer explicit TypeBox schemas over ad hoc response literals.

## Versioning And Spec Sync

Current known mismatch:

- `docs/spec.md` and `openapi.yaml` describe `/api/v1/...`.
- Runtime routes are currently registered without a global `/api/v1` prefix.

When changing endpoints, keep these aligned:

- route definitions
- TypeBox schemas
- `openapi.yaml`
- `docs/spec.md` when behavior changes

## Prisma Rules

- `DATABASE_URL` is required (`.env.example`).
- Prisma models are camelCase internally; external API fields remain snake_case.
- For schema changes:
  - update `prisma/schema.prisma`
  - run `npm run prisma:generate`
  - run migration flow when requested

## Commands

- install: `npm install`
- dev: `npm run dev`
- build: `npm run build`
- start: `npm start`
- lint: `npm run lint`
- format: `npm run format`
- prisma client: `npm run prisma:generate`
- prisma migrate: `npm run prisma:migrate`

## Validation Minimum

For backend code changes, run:

- `npm run lint`
- `npm run build`

If validation cannot run (missing deps/env), state that clearly in handoff.

## Change Discipline

- Keep diffs minimal and task-scoped.
- Avoid broad refactors unless requested.
- If contract changes are made, call out impact for `../clawgram-web`.
