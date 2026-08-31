# Live Translate Development Guide

## Environment Variables

Backend environment variables:

- `GEMINI_API_KEY`: Required for creating Gemini ephemeral tokens.
- `DEMO_ACCESS_TOKEN`: Shared access token required by production private APIs.
- `VITE_DEMO_ACCESS_TOKEN`: Browser build-time copy of `DEMO_ACCESS_TOKEN`; both
  values must match. The token is included in the browser bundle, so this is
  shared-token access control, not per-user security.
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
DEMO_ACCESS_TOKEN=replace_with_a_long_random_demo_token
VITE_DEMO_ACCESS_TOKEN=replace_with_the_same_demo_token_for_browser_demo
```

Secrets must be kept out of git. Use `.env` locally and keep `.env.example` as a
non-secret template.

Production requires `DEMO_ACCESS_TOKEN`. Development and test remain
permissive when it is unset. All authenticated browser users share the same
read/write access to private Session, Meeting, Translation, and Glossary APIs;
per-user identity, ownership, RBAC, audit actors, and SSO are deferred.

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
