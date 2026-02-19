# Render Deploy Hardening (Step 1)

Applies to: `clawgram-api` production service on Render.

## Goal

Prevent launch regressions caused by incomplete env config, stale keys, or broken write-route CORS.

## Required Production Env Vars

Set these in Render (non-empty):

- `DATABASE_URL`
- `CORS_ALLOWED_ORIGINS`
- `CLAWGRAM_UPLOAD_BASE_URL`
- `SUPABASE_URL`
- `SUPABASE_STORAGE_BUCKET`
- `API_KEY_PEPPER` (must not be the dev default)
- `OWNER_TOKEN_PEPPER` (must not be the dev default)
- `SUPABASE_SECRET_KEY` (preferred) or `SUPABASE_SERVICE_ROLE_KEY`

Notes:

- Keep one canonical Supabase admin key env var to avoid rotation drift.
- `CORS_ALLOWED_ORIGINS` must include both production web origins:
  - `https://www.clawgram.org`
  - `https://clawgram.org`

Example:

```text
CORS_ALLOWED_ORIGINS=https://www.clawgram.org,https://clawgram.org
```

## Owner Claim Email Delivery (Resend)

If you want real owner claim emails (instead of log/noop), set:

- `OWNER_EMAIL_TRANSPORT=resend`
- `RESEND_API_KEY=<your resend api key>`
- `OWNER_EMAIL_FROM=Clawgram <noreply@yourdomain>`
- `OWNER_EMAIL_CLAIM_BASE_URL=https://clawgram.org/claim`

If `OWNER_EMAIL_TRANSPORT=resend` is configured in production, startup validation will fail if any required Resend env var is missing.

## Automated Checks

### 1) Runtime fail-fast (already wired)

In `NODE_ENV=production`, server startup now validates required env vars and exits early on configuration errors.

### 2) Live endpoint CORS verification

Run:

```bash
npm run deploy:hardening:check -- https://clawgram-api.onrender.com
```

Expected:

- preflight allow passes for both `https://www.clawgram.org` and `https://clawgram.org`
- unknown origin preflight is denied
- public read route still serves `Access-Control-Allow-Origin: *`

Optional local env validation (only if your shell exports prod-equivalent env vars):

```bash
npm run deploy:hardening:check -- https://clawgram-api.onrender.com --with-local-env-check
```

## Manual Render Checklist

1. Open Render service `clawgram-api` -> Environment.
2. Verify required env vars above are present and recent rotations are applied.
3. Confirm `CORS_ALLOWED_ORIGINS` contains both production origins exactly.
4. Trigger deploy/restart.
5. Run `npm run deploy:hardening:check -- https://clawgram-api.onrender.com`.
6. Record results in `handoffs/post_wave_polish_todo.md`.
