# Live Translate Architecture

## System Architecture

Live Translate uses a browser-first real-time path with a narrow backend service.

- Frontend: React + JavaScript, Web Audio API, and Gemini Live API client logic.
- Backend: Node.js HTTP server for authentication, token issuance, and
  configuration validation.
- Gemini: Gemini Live API using `gemini-3.5-live-translate-preview`.

The browser connects directly to Gemini Live API using an ephemeral token issued
by the backend.

The backend is responsible only for authentication, token issuance, and
configuration validation.

Audio streams are not proxied through the backend.

## Direct Browser -> Gemini Live API Design

The browser streams microphone audio directly to Gemini Live API after receiving
a short-lived ephemeral token from the backend.

This design keeps the latency-sensitive audio path out of the backend and avoids
server-side audio relay costs for the MVP. The backend does not receive raw
microphone audio, translated audio, or transcript events.

## Backend Token Issuance Design

The backend exposes `POST /api/live-token`.

Responsibilities:

- Read and validate the requested target language.
- Default `echoTargetLanguage` to `true` when omitted.
- Create a Gemini ephemeral token using `GEMINI_API_KEY`.
- Return only the ephemeral token name and expiration time to the browser.
- Map validation and provider failures to stable HTTP error responses.

The backend must not return the real Gemini API key or any long-lived credential.

## Frontend Responsibilities

- Render the translation controls and transcript display.
- Maintain explicit session state.
- Request microphone permission.
- Capture microphone audio with the Web Audio API.
- Convert microphone samples to raw PCM 16-bit 16kHz mono chunks.
- Request an ephemeral token from the backend.
- Connect directly to Gemini Live API with the ephemeral token.
- Send audio chunks to Gemini while the session is active.
- Play returned translated audio.
- Display input and output transcript updates.
- Stop microphone tracks and close the live session when the user stops.
- Surface recoverable errors to the user.

## Backend Responsibilities

- Serve `POST /api/live-token`.
- Validate request JSON.
- Validate `targetLanguageCode` against the allowlist.
- Validate or default token configuration options.
- Use `GEMINI_API_KEY` only on the server.
- Create Gemini ephemeral tokens.
- Return consistent JSON responses.
- Support local frontend CORS configuration.

The backend must not proxy audio, store transcripts, or maintain session state in
the MVP.

## Gemini Live Session Flow

1. User starts a session in the browser.
2. Browser requests microphone permission.
3. Browser posts token options to `POST /api/live-token`.
4. Backend validates the request and creates an ephemeral token.
5. Browser opens a Gemini Live API session using the ephemeral token.
6. Browser sends input audio chunks to Gemini.
7. Gemini returns translated audio and transcript events.
8. Browser plays audio and updates transcripts.
9. User stops the session or the session ends.
10. Browser closes the Gemini session and stops microphone tracks.

TODO: Confirm the exact Gemini Live API client method names and event payload
shapes against the current official SDK before implementation changes.

## Audio Pipeline

Input to Gemini:

- Raw PCM.
- 16-bit signed integer.
- 16kHz.
- Mono.
- Little-endian.
- Sent in roughly 100ms chunks.

Output from Gemini:

- Raw PCM.
- 16-bit signed integer.
- 24kHz.
- Mono.
- Little-endian.

Frontend pipeline:

1. Capture microphone input.
2. Read floating-point PCM samples from the browser audio graph.
3. Resample to 16kHz if the input device uses a different sample rate.
4. Convert samples to little-endian PCM16 bytes.
5. Send chunks to Gemini Live API.
6. Decode Gemini output audio bytes.
7. Schedule translated audio playback at 24kHz.

## Frontend State Machine

- `idle`: No active session.
- `requesting-permission`: Browser microphone prompt is active.
- `connecting`: Token request or Gemini session setup is active.
- `listening`: Microphone audio is being translated.
- `stopped`: User stopped the session.
- `error`: Recoverable error with retry available.

Expected transitions:

- `idle` -> `requesting-permission` when the user starts.
- `requesting-permission` -> `connecting` after microphone access is granted.
- `requesting-permission` -> `error` if permission is denied.
- `connecting` -> `listening` after Gemini session setup succeeds.
- `connecting` -> `error` if token creation or session setup fails.
- `listening` -> `stopped` when the user stops.
- `listening` -> `error` when an unrecoverable session error occurs.
- `error` -> `idle` when the user retries or resets.

## Error Recovery Strategy

- Permission denied: stop setup, show a clear recoverable error, and allow retry.
- Invalid target language: show validation failure and keep the user out of an
  active session.
- Token issuance failure: stop setup and allow retry.
- Gemini session connection failure: close any partial session, stop microphone
  tracks, and allow retry.
- Audio playback failure: stop the session and show a recoverable error.
- Session ended by Gemini: stop microphone tracks and move to `stopped` or
  `error` depending on whether the end was expected.

## Security Considerations

- `GEMINI_API_KEY` must stay on the backend.
- The browser may receive only short-lived ephemeral tokens.
- Ephemeral tokens should be scoped to the Live Translate model and required
  session configuration.
- Token requests must validate `targetLanguageCode`.
- Backend CORS should be restricted to the local frontend origin in development
  and the production frontend origin in deployment.
- The backend should not log secrets, raw audio, or transcript content.
- The backend should not proxy, store, or inspect live audio streams in the MVP.

## Suggested Project Structure

```text
.
├── docs/
│   ├── spec.md
│   ├── architecture.md
│   ├── api.md
│   ├── development.md
│   └── decisions.md
├── server/
│   ├── index.js
│   ├── languages.js
│   └── tokenService.js
├── src/
│   ├── lib/
│   │   ├── audio.js
│   │   ├── languages.js
│   │   └── liveSession.js
│   ├── main.jsx
│   └── styles.css
├── tests/
│   ├── audio.test.js
│   └── tokenService.test.js
├── .env.example
├── package.json
└── vite.config.js
```

