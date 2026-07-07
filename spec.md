# Live Translate Web App Spec

## Summary

Build a real-time speech translation web app with a React + JavaScript frontend, a Node.js backend, and Gemini Live API using `gemini-3.5-live-translate-preview`.

The browser captures microphone audio, converts it to raw PCM 16-bit 16kHz mono chunks, and connects directly to Gemini Live API with a short-lived ephemeral token issued by the backend. Gemini returns translated 24kHz PCM audio plus input and output transcripts.

## Goals

- Start and stop a live speech translation session from the browser.
- Let the user choose a target translation language.
- Play translated audio in near real time.
- Show source and translated transcripts.
- Keep `GEMINI_API_KEY` only on the backend.

## Non-Goals

- User accounts.
- Persistent transcript history.
- Room sharing or multi-user calls.
- Text input translation.
- Full benchmark or real API validation in automated tests.

## Architecture

- Frontend:
  - React + JavaScript.
  - Uses Web Audio API and `@google/genai`.
  - Fetches ephemeral tokens from the backend.
  - Connects directly to Gemini Live API to reduce audio streaming latency.

- Backend:
  - Node.js HTTP server.
  - Endpoint: `POST /api/live-token`.
  - Uses `@google/genai` server-side to create ephemeral tokens.
  - Validates target language and token configuration.

- Gemini:
  - Model: `gemini-3.5-live-translate-preview`.
  - Response modality: `AUDIO`.
  - Input transcription enabled.
  - Output transcription enabled.
  - Translation config contains `targetLanguageCode` and `echoTargetLanguage`.

## Public API

### `POST /api/live-token`

Request:

```json
{
  "targetLanguageCode": "zh-Hant",
  "echoTargetLanguage": true
}
```

Response:

```json
{
  "token": "ephemeral-token-name",
  "expiresAt": "2026-07-06T08:30:00.000Z"
}
```

Validation:

- `targetLanguageCode` must be in the allowlist.
- `echoTargetLanguage` defaults to `true`.
- Invalid requests return `400`.
- Missing `GEMINI_API_KEY` returns `500`.
- Gemini token creation failures return `502`.

## Audio Contract

- Input to Gemini:
  - Raw PCM.
  - 16-bit signed integer.
  - 16kHz.
  - Mono.
  - Little-endian.
  - Sent in roughly 100ms chunks.

- Output from Gemini:
  - Raw PCM.
  - 16-bit signed integer.
  - 24kHz.
  - Mono.
  - Little-endian.

## Frontend States

- `idle`: no active session.
- `requesting-permission`: browser microphone prompt is active.
- `connecting`: token/session setup is active.
- `listening`: mic stream is being translated.
- `stopped`: user stopped the session.
- `error`: recoverable error with retry available.

## Supported MVP Languages

- English: `en`
- Japanese: `ja`
- Korean: `ko`
- Traditional Chinese: `zh-Hant`
- Simplified Chinese: `zh-Hans`
- Spanish: `es`
- French: `fr`
- German: `de`

Default target language: `zh-Hant`.

## Test Plan

- Backend unit tests:
  - Valid token request.
  - Invalid language.
  - Default `echoTargetLanguage`.
  - Gemini token creation failure.

- Audio helper unit tests:
  - Float audio converts to little-endian PCM16.
  - Resampling produces deterministic output length.
  - Base64 PCM conversion round-trips.

- Manual smoke test with explicit real API approval:
  - Start local frontend/backend.
  - Select `zh-Hant`.
  - Speak English.
  - Confirm translated audio plays and both transcripts update.
  - Stop session and confirm microphone tracks close.

