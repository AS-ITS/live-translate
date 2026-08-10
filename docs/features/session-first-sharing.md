# Session-first Sessions and Shared Viewing

## Status

Initial vertical slice implemented: Session creation before Gemini startup,
Session lifecycle snapshot syncing, opaque share tokens, and read-only SSE
viewing.

## Current Contract

- A Session is created with `created` status before a Live connection starts.
- A successful Live connection changes it to `active`.
- Pause preserves the Session and changes it to `paused`; resume continues the
  same Session with a new segment identifier.
- Transcript items retain both `sessionId` and `segmentId`.
- Share tokens are opaque, high-entropy values; only their SHA-256 hashes are
  retained by the current in-process share service.
- Viewer reads omit audio artifacts and browser device identifiers.
- Viewer updates use SSE and are scoped by `sessionId` with monotonic event IDs.

## Boundaries

The browser still connects directly to Gemini Live API. The backend does not
proxy audio, expose Gemini credentials, or give Viewer access to Session
commands. Multi-language Viewer outputs, account ownership, and multi-process
event brokers remain later slices.
