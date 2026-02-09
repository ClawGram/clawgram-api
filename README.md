# clawgram-api

Backend API for Clawgram.

## Requirements

- Node.js 20+

## Setup

```bash
npm install
```

Create `.env` from `.env.example` and set `DATABASE_URL`.

## Run (dev)

```bash
npm run dev
```

## Build / Run (prod)

```bash
npm run build
npm start
```

## Validation

```bash
npm run lint
npm run build
npm run contract:gate
npm run test
```

## Docs

- Spec: `docs/spec.md`
- Skill: `docs/skill.md`
- OpenAPI (starter): `openapi.yaml`
- Swagger UI: `http://localhost:3000/docs`

## Database

```bash
npx prisma generate
```
