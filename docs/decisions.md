# Live Translate Technical Decisions

## ADR-001: Use React + JavaScript frontend

Status: Accepted

Context:

The MVP needs a browser UI for language selection, microphone permission,
session controls, transcript display, and translated audio playback. The current
project uses React with JavaScript.

Decision:

Use React + JavaScript for the frontend.

Consequences:

- The UI can be implemented with a common component model.
- The app can use browser-native Web Audio APIs directly.
- The project avoids a TypeScript migration in the MVP.
- Runtime validation and careful helper tests remain important because there is
  no compile-time type checking.

## ADR-002: Use Node.js backend for token issuance

Status: Accepted

Context:

The app needs a trusted server-side component to validate recorder requests and
issue short-lived Gemini ephemeral tokens. Live requests provide the Gemini
key in request-scoped memory; isolated non-Live workers may use a server
`GEMINI_API_KEY`.

Decision:

Use a small Node.js backend for token issuance and request validation.

Consequences:

- The backend can share JavaScript tooling with the frontend project.
- The backend remains narrow and stateless for MVP.
- The backend must not grow into an audio proxy unless a future requirement
  explicitly changes the architecture.

## ADR-003: Use direct browser connection to Gemini Live API

Status: Accepted

Context:

Live speech translation is latency-sensitive. Proxying microphone and translated
audio through the backend would add backend complexity and an additional network
hop.

Decision:

Connect the browser directly to Gemini Live API after obtaining a backend-issued
ephemeral token.

Consequences:

- The backend does not process, store, or relay live audio.
- The audio path is shorter and better suited for near real-time behavior.
- The frontend owns session handling, audio capture, audio playback, and Gemini
  event handling.
- The backend still controls credential safety through ephemeral token issuance.

## ADR-004: Use Gemini ephemeral tokens instead of exposing API keys

Status: Accepted

Context:

The frontend needs to connect to Gemini Live API, but exposing `GEMINI_API_KEY`
in browser code would leak a long-lived credential.

Decision:

Use Gemini ephemeral tokens issued by the backend.

Consequences:

- Live token issuance does not read `GEMINI_API_KEY`; it uses only the
  recorder's request-scoped key. Non-Live workers keep any environment key
  isolated to their own provider composition.
- Browser sessions receive only short-lived scoped credentials.
- The backend must validate token configuration before issuing a token.
- Token creation failures must be surfaced as recoverable frontend errors.

## ADR-005: MVP uses audio input and translated audio + transcripts

Status: Accepted

Context:

The core MVP value is spoken real-time translation. The initial product should
focus on microphone input, translated speech playback, and transcript visibility.

Decision:

The MVP uses audio input and returns translated audio plus input and output
transcripts.

Consequences:

- Text input translation remains out of scope for v1.
- Persistent transcript history remains out of scope for v1.
- Audio format conversion and playback are first-class frontend concerns.
- The smoke test must verify both translated audio and transcript updates.
