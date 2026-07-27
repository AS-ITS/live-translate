# Live Translate

Live Translate is a browser-based real-time speech translation app. The React
frontend captures microphone audio, requests a short-lived Gemini ephemeral
token from the Node.js backend, then connects directly to the Gemini Live API.

The backend owns `GEMINI_API_KEY`; the browser must never receive long-lived
credentials.

## Overview

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

- `NODE_ENV`: `development` locally, `production` for the built Node service.
- `PORT`: backend port, defaults to `3000`.
- `DATA_DIR`: directory for file-backed persistence, defaults to `./data`
  outside production and `/var/data` in production.
- `TRANSLATION_PROVIDER`: saved retranslation provider, defaults to `gemini`.
- `GEMINI_API_KEY`: server-only Gemini credential.
- `LIVE_TRANSLATE_MODEL`: Gemini Live translation model.
- `SAVED_RETRANSLATION_GEMINI_MODEL`: model for saved-session retranslation.
- `SESSION_RECORDS_FILE`: optional override for saved session records.

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

For Render, configure environment variables on the service instead of committing
secrets:

```env
NODE_ENV=production
PORT=3000
DATA_DIR=/var/data
TRANSLATION_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_api_key
ALLOWED_ORIGIN=https://your-render-service.onrender.com
DEMO_ACCESS_TOKEN=replace_with_a_long_random_demo_token
```

Attach a Render Persistent Disk mounted at `/var/data` when saved sessions,
durable queue state, glossary data, or dead-letter queue files must survive
restarts.

## Tests

Run focused deterministic tests as needed:

```bash
npm run test:unit
npm run test:integration
npm run test:e2e
```

The live smoke test is safe by default and does not call Gemini unless explicitly
enabled:

```bash
npm run test:live-smoke
```

Real Gemini validation requires opt-in configuration:

```bash
ENABLE_REAL_GEMINI_TEST=true GEMINI_API_KEY=your_real_key npm run test:live-smoke
```

See [docs/TESTING.md](docs/TESTING.md) for the full testing policy and targeted
commands.

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
- Do not run real Gemini tests unless `ENABLE_REAL_GEMINI_TEST=true` is set on
  purpose.
