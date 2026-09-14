# Live Translate Development Guide

Local runtime persistence is Supabase-only. JSON files under `data/` are
legacy test fixtures and are not read by the application.

```bash
supabase start
supabase db reset
supabase db lint
```

Copy the local API URL and service-role key from `supabase status` into the
server-only `SUPABASE_URL` and `SUPABASE_SECRET_KEY` values in `.env`. Never
commit or log the service key. Use `/readyz` to distinguish an unavailable
Supabase endpoint, missing migrations, and invalid credentials.

## Environment Variables

Backend environment variables:

- `GEMINI_API_KEY`: Required for creating Gemini ephemeral tokens.
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY`: server-only Supabase values.
- `SUPABASE_JWKS_URL`: Supabase public JWKS endpoint used to verify access tokens.
- `AUTH_ALLOWED_EMAIL_DOMAINS`: comma-separated Workspace email domains.
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`: browser-safe values.
- `P1_PROFILE_ONLY=true`: optional compatibility switch that keeps non-Profile
  cloud capabilities fail-closed. Leave unset for the current owner-scoped
  cloud runtime.
- Supabase P2 mode stores each user's Gemini API Key in Vault; apply the Vault migration before enabling personal-key token issuance.
- `SAVED_RETRANSLATION_TIMEOUT_MS`: Optional timeout for saved transcript
  retranslation Gemini calls. Defaults to `30000`.
- `dev_frontend_origin`: Development frontend origin. Defaults to
  `http://127.0.0.1:5173`.
- `dev_backend_origin`: Development backend origin used by the Vite proxy.
  Defaults to `http://127.0.0.1:3000`.
- `DATA_DIR`: Optional directory for file-backed persistence. Defaults to
  `./data` outside production and `/var/data` in production.
- `SESSION_SNAPSHOT_MAX_BYTES`: Optional saved session snapshot JSON request
  limit. Defaults to `26214400`.
- `SESSION_AUDIO_MAX_BYTES`: Optional per-request WAV upload limit. Defaults to
  `52428800`.
- `SESSION_SHARES_FILE`: Optional override for persisted session share tokens.

The development server binds to `127.0.0.1:3000` and Vite binds to
`127.0.0.1:5173`. The production server binds to `0.0.0.0:8000` and accepts
the origin `http://127.0.0.1:8000`.

Development example:

```env
GEMINI_API_KEY=your_gemini_api_key
SAVED_RETRANSLATION_TIMEOUT_MS=30000
dev_frontend_origin=http://127.0.0.1:5173
dev_backend_origin=http://127.0.0.1:3000
DATA_DIR=./data
SESSION_SNAPSHOT_MAX_BYTES=26214400
SESSION_AUDIO_MAX_BYTES=52428800
```

## Vercel and Supabase cloud capabilities

P0 keeps the local Node runtime unchanged and adds a cloud-only Function shell.
Vercel Functions do not use the local WebSocket broadcaster or file-backed
`data/` directory. Translation work is processed by the bounded Vercel Cron
worker at `/api/internal/worker`. They expose health/readiness checks and return
a structured `503` when a cloud dependency is unavailable.

Use the Supabase CLI migration workflow locally:

```bash
npm run db:start
npm run db:reset
npm run db:lint
```

Vercel environment variables are configured per environment in the Vercel
project. Keep `SUPABASE_SECRET_KEY` and future `KEY_ENCRYPTION_SECRET`
server-only; never prefix them with `VITE_`. The 4.5 MB Vercel Function
request/response limit means the current large snapshot, checkpoint, and audio
routes remain disabled in the P0 cloud shell.

Secrets must be kept out of git. Use `.env` locally and keep `.env.example` as a
non-secret template.

Supabase mode requires a valid JWT, the `authenticated` role, and an email in
`AUTH_ALLOWED_EMAIL_DOMAINS`. Supabase access tokens are required for all
authenticated flows. P1 owner-scoped adapters support these cloud capabilities:

| Capability | Persistence / boundary |
| --- | --- |
| Meetings, Segments, Sessions, finalized Cues | Supabase repositories under owner-scoped RLS |
| Shares, recorder leases, audio metadata | Supabase repositories and private Storage metadata |
| Glossary, translation queue, DLQ, execution status | Supabase repositories and atomic queue RPCs |
| Meeting Viewer events | `meeting_events` persistence with cursor replay and Realtime delivery |
| Observability | Service-role metric RPCs and UTC-minute buckets |

If the required Supabase configuration is missing, or `/readyz` cannot verify
the observability table and RPC, these cloud APIs remain fail-closed with a
structured `503`.

## Cloud rollout preflight

When `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `SUPABASE_JWKS_URL` are
configured, new cloud writes use the owner-scoped Supabase repositories listed
above. Existing file-backed records are not migrated automatically. Before
production traffic, apply all migrations through
`20260914000000_observability_metric_buckets.sql`, run `npm run db:lint`, and
verify `/healthz` and `/readyz`. Readiness must confirm the observability table
and atomic metric RPC. The worker cron must use `Authorization: Bearer
$CRON_SECRET`; metric persistence is best-effort and must not change queue
processing outcomes.

Production smoke checks and alert thresholds are maintained in
[`docs/observability-runbook.md`](observability-runbook.md). Production
verification is a rollout task, not an unimplemented P1 capability.

## Local Development Setup

1. Install dependencies only when needed for local development.
2. Create a local `.env` file based on `.env.example`.
3. Start the backend server.
4. Start the frontend development server.
5. Open the frontend in a browser that supports the required Web Audio APIs.

When the Vite dev server is running, enter `o` followed by Enter in the same
terminal to open the actual Vite URL in the default browser. If the terminal
does not provide interactive keyboard input, or the operating-system browser
launcher is unavailable, use the URL printed by Vite manually. When port 5173
is already occupied, use the replacement port shown in that output.

Do not use real Gemini API calls for automated tests. Use real API calls only for
manual smoke testing with explicit approval.

## Development Milestones

1. Backend token endpoint
   - Implement `POST /api/live-token`.
   - Validate language and token options.
   - Create Gemini ephemeral tokens with server-side credentials.
   - Add unit tests with a mocked Gemini client.

2. Audio helpers
   - Convert float samples to PCM16 little-endian bytes.
   - Resample microphone audio to 16kHz.
   - Convert bytes to and from base64 when required by SDK payloads.
   - Add deterministic unit tests.

3. Frontend session lifecycle
   - Add explicit frontend states.
   - Request microphone permission.
   - Request ephemeral token.
   - Open and close Gemini Live sessions.

4. Live audio streaming
   - Capture microphone samples.
   - Chunk input audio into roughly 100ms frames.
   - Send chunks to Gemini.
   - Stop streaming cleanly when the session ends.

5. Output handling
   - Play translated audio.
   - Display input transcripts.
   - Display output transcripts.
   - Handle session errors and expected session end.

6. Manual smoke validation
   - Run local frontend and backend.
   - Use a real API key only after explicit approval.
   - Confirm the complete start, translate, playback, transcript, and stop flow.

## Manual Smoke Test Steps

Manual smoke testing requires explicit approval because it uses a real Gemini API
key.

Steps:

1. Start the backend with `GEMINI_API_KEY` configured.
2. Start the frontend development server.
3. Open the app in the browser.
4. Select `zh-Hant`.
5. Start a session.
6. Grant microphone permission.
7. Speak English.
8. Confirm translated audio plays.
9. Confirm source transcript updates.
10. Confirm translated transcript updates.
11. Stop the session.
12. Confirm microphone tracks close.
13. Confirm the UI returns to a non-listening state.

## Testing Scope

Backend unit tests:

- Valid token request.
- Invalid language.
- Default `echoTargetLanguage`.
- Gemini token creation failure.

Audio helper unit tests:

- Float audio converts to little-endian PCM16.
- Resampling produces deterministic output length.
- Base64 PCM conversion round-trips.

Frontend testing scope for MVP:

- Prefer focused unit tests for pure helpers.
- Prefer manual smoke testing for real microphone and Live API behavior.
- Avoid real API usage in automated tests.
- Avoid full benchmark or calibration runs unless the task specifically requests
  them.

## Coding Guidelines

- Keep the backend token service small and stateless.
- Keep Gemini API keys and long-lived credentials server-side only.
- Keep frontend session states explicit.
- Clean up microphone tracks, audio nodes, and Gemini sessions on stop or error.
- Keep SDK-specific event parsing isolated enough to update when Gemini payloads
  change.
- Prefer deterministic helper tests over browser or real API integration tests
  for MVP development.
- Mark uncertain provider fields with TODOs until verified against official SDK
  documentation.

## Out of Scope for v1

- User accounts.
- Persistent transcript storage.
- Room sharing or multi-user calls.
- Text input translation.
- Backend audio proxying.
- Server-side recording.
- Production analytics dashboards.
- Automated real Gemini API integration tests.
- Full benchmark runs.
- Dataset generation or benchmark report regeneration.

## Runtime capability matrix

| Capability | Local Node runtime | Vercel/Supabase runtime |
| --- | --- | --- |
| Meeting, Segment, Session, Cue persistence | Supabase configuration required; JSON files are test-only fixtures | Owner-scoped Supabase repositories |
| Checkpoint path IDs | UUIDs for newly created records; legacy test adapters may opt out of strict path validation | UUIDs required |
| Translation execution | Local worker runtime | Bounded `/api/internal/worker` Cron batches |
| Viewer delivery | Local SSE/WebSocket adapters | Supabase Realtime and signed Storage URLs |
| Readiness | `/readyz` reports required runtime configuration | `/readyz` also requires Supabase auth configuration |

For the safe deployment preflight, set `SMOKE_BASE_URL` and run `npm run test:deployment-preflight`. It verifies `/healthz`, `/readyz`, unauthenticated private API rejection, metrics auth rejection, and worker auth rejection without calling Gemini or processing queue items. For the full staging smoke check, separately verify a valid owner-scoped API request and one authenticated worker request with `Authorization: Bearer $CRON_SECRET`. A successful `/healthz` response alone does not prove that Supabase migrations, RLS, Storage, Realtime, or the worker are ready.
## Production Gemini Smoke Test

For the first Production Gemini smoke test, keep the request short and avoid
the default long-meeting soak:

```bash
LIVE_SMOKE_DURATION_MS=60000 \
LIVE_SMOKE_SPEECH_INTERVAL_MS=10000 \
LIVE_SMOKE_REQUIRE_RECONNECT=false \
npm run test:live-smoke
```

Run this once only after confirming the Production `GEMINI_API_KEY` is
available to the smoke runner. Do not place that key in browser-exposed
`VITE_` variables or commit it.
### OAuth Workspace access

Google OAuth can complete successfully while `GET /api/profile` rejects a personal or otherwise unapproved account with `403 auth_forbidden`. `AUTH_ALLOWED_EMAIL_DOMAINS` remains the backend authority; Google `hd` hints are optional UI guidance only and are not an authorization control. The access-denied screen keeps the session long enough to show the current email, and users must choose “切換 Google 帳號” to sign out and reopen the Google account picker with `prompt=select_account`.
