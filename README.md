# Live Translate

Local runtime persistence is Supabase-only. Start the local stack with
`supabase start` and apply migrations with `supabase db reset`; `data/` is not
read by the application.

Live Translate is a browser-based real-time speech translation app. The React
frontend captures microphone audio, requests a short-lived Gemini ephemeral
token from the Node.js backend, then connects directly to the Gemini Live API.

The backend owns `GEMINI_API_KEY`; the browser must never receive long-lived
credentials.

## Overview

Google Workspace domain matching does not immediately grant access. New users start as pending `member` profiles and require approval by an active `super_admin`; pending users only see the approval waiting screen and may sign out or switch accounts.

- Frontend: React, Vite, Web Audio API, and Gemini Live client logic.
- Backend: Node.js service for token issuance, validation, and local APIs.
- Live path: browser audio streams directly to Gemini Live API.
- Saved sessions: transcript records can be stored locally and reused for
  saved-session retranslation.

Current development is focused on the internal-tool phase. See
[CHANGELOG.md](CHANGELOG.md) and [docs/ROADMAP.md](docs/ROADMAP.md) for detailed
status.

## Requirements

- Node.js compatible with the project dependencies.
- npm.
- A Gemini API key for manual live translation or production-like local runs.

Automated tests use fakes and mocks by default and must not call the real Gemini
API.

## Configuration

Create local environment configuration outside version control. Common settings:

- Development origin settings are `dev_frontend_origin` (default
  `http://127.0.0.1:5173`) and `dev_backend_origin` (default
  `http://127.0.0.1:3000`).
- `DATA_DIR`: directory for file-backed persistence, defaults to `./data`
  outside production and `/var/data` in production.
- `TRANSLATION_PROVIDER`: saved retranslation provider, defaults to `gemini`.
- `GEMINI_API_KEY`: server-only Gemini credential.
- `LIVE_TRANSLATE_MODEL`: Gemini Live translation model.
- `SAVED_RETRANSLATION_GEMINI_MODEL`: model for saved-session retranslation.
- `SESSION_RECORDS_FILE`: optional override for saved session records.
- `SESSION_SHARES_FILE`: optional override for persisted session share tokens.
- `SESSION_SNAPSHOT_MAX_BYTES`: optional saved session snapshot JSON request
  limit, defaults to `26214400` bytes.
- `MEETING_CHECKPOINT_MAX_BYTES`: optional Meeting checkpoint JSON request
  limit, defaults to `26214400` bytes.
- `SESSION_AUDIO_MAX_BYTES`: optional per-request WAV upload limit, defaults to
  `52428800` bytes.

Durable queue, dead-letter queue, glossary, timeout, and provider settings are
documented in [docs/architecture.md](docs/architecture.md) and the feature docs.

## Run Locally

Install dependencies:

```bash
npm install
```

Start the backend:

```bash
npm run server
```

Start the frontend in another shell:

```bash
npm run dev
```

Open the Vite URL printed by `npm run dev`.

## Production

Build and start the production service:

```bash
npm ci
npm run build
npm run start
```

In production, the Node.js server provides both `/api/*` routes and the built
frontend from `dist/`. Non-API browser routes fall back to `dist/index.html`.
Use the npm scripts above to select production mode; do not configure runtime
mode in local environment files loaded by Vite.

Deployment platform commands:

```text
Install Command: npm ci
Build Command: npm run build
Start Command: npm run start
```

For Render, configure environment variables on the service instead of committing
secrets:

```env
DATA_DIR=/var/data
TRANSLATION_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_api_key
```

Attach a Render Persistent Disk mounted at `/var/data` when saved sessions,
durable queue state, glossary data, or dead-letter queue files must survive
restarts.

## Cloud deployment (P3)

The repository also contains the Issue #31 deployment foundation:

- Vercel uses `npm run build` and the catch-all Node Function under `api/`.
- `/healthz`, `/readyz`, authenticated Meeting APIs, private Storage metadata,
  and Viewer Realtime token exchange are available through the Function.
- Local Supabase development uses `npm run db:start`, `npm run db:reset`, and
  `npm run db:lint`.
- Development uses the local Supabase stack, preview uses an isolated Supabase
  branch, and production uses a separate Supabase project.
- Apply all migrations through
  `20260914000000_observability_metric_buckets.sql`. They create owner RLS,
  the private `meeting-audio` bucket, Viewer Realtime authorization, persisted
  Cue broadcasts, durable queue operations, event replay, and observability
  metric buckets.

Required cloud variables include `SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
`SUPABASE_JWKS_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
`AUTH_ALLOWED_EMAIL_DOMAINS`, `APP_ORIGIN`, and
`SUPABASE_REALTIME_SIGNING_PRIVATE_JWK`. The Realtime key is a private JWK whose
`kid` matches a Supabase JWT signing key; never expose it through a `VITE_`
variable.

## Vercel Cron worker

Vercel calls `/api/internal/worker` every minute. Configure `CRON_SECRET` and
`WORKER_BATCH_SIZE`; the worker processes a bounded batch from the Supabase
durable queue and does not rely on process-local polling.

## Tests

Run focused deterministic tests as needed:

```bash
npm run test:unit
npm run test:integration
npm run test:e2e
```

The direct long-meeting smoke test requires `GEMINI_API_KEY` and calls Gemini:

```bash
./scripts/live-meeting-smoke.sh
```

The equivalent npm command is:

```bash
npm run test:live-smoke
```

For a safe no-op check, run `node scripts/live-smoke-test.js` without
`ENABLE_REAL_GEMINI_TEST=true`.

The real smoke test runs a 2-hour macOS-generated speech soak by default and
checks transcription reconnects plus the token request limit. See
`docs/TESTING.md` for optional duration and speech settings.

See [docs/TESTING.md](docs/TESTING.md) for the full testing policy and targeted
commands.

PR CI runs deterministic application checks, local Supabase migration reset/lint,
and a read-only preflight against each successful Vercel Preview deployment.
Cloud validation is production-only and runs a read-only preflight. Staging-equivalent
validation uses local Supabase, the local backend, and local E2E tests. See
[testing and cloud validation](docs/TESTING.md#manual-cloud-validation) for workflow details
and commands.

## Documentation

- [docs/spec.md](docs/spec.md): product scope and core requirements.
- [docs/architecture/architecture-overview.md](docs/architecture/architecture-overview.md):
  high-level system map.
- [docs/architecture.md](docs/architecture.md): architecture details and runtime
  design notes.
- [docs/api.md](docs/api.md): backend API contracts.
- [docs/TESTING.md](docs/TESTING.md): testing strategy and commands.
- [CHANGELOG.md](CHANGELOG.md): completed and unreleased changes.

## Safety Notes

- Never expose `GEMINI_API_KEY` to frontend code.
- Never log Gemini API keys or ephemeral tokens.
- Keep `/api/live-token` validation, access gate, rate limit, and origin checks.
- The shell smoke-test entrypoint intentionally enables the real Gemini call
  after confirming `GEMINI_API_KEY`; run it only when quota usage is intended.
## Preview deployment

After linking this repository to the intended Vercel project once, deploy a Preview with:

```bash
vercel link
npm run deploy:preview
```

The command deploys without the production flag, prints the Preview URL, and runs the deployment preflight against it. Configure Preview environment variables in Vercel before deploying, including `GEMINI_API_KEY` and the required Supabase settings.

Apply pending Supabase migrations separately:

```bash
supabase link --project-ref <target-project-ref>
npm run deploy:supabase
```

The migration command uses the currently linked Supabase project and does not create branches or switch projects automatically. Verify the linked project is the intended Preview or test environment before running it.
