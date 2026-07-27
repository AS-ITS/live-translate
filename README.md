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

- `GEMINI_API_KEY`: server-only Gemini credential.
- `LIVE_TRANSLATE_MODEL`: Gemini Live translation model.
- `SAVED_RETRANSLATION_GEMINI_MODEL`: model for saved-session retranslation.
- `SESSION_RECORDS_FILE`: optional path for file-backed saved session records.

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
