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
  retained by the file-backed share service.
- Share records are persisted under `DATA_DIR/session-shares.json` by default;
  `SESSION_SHARES_FILE` can override the exact path, so links remain valid after
  a backend restart.
- Viewer reads omit audio artifacts and browser device identifiers.
- Viewer updates use SSE and are scoped by `sessionId` with monotonic event IDs.

## Boundaries

The browser still connects directly to Gemini Live API. The backend does not
proxy audio, expose Gemini credentials, or give Viewer access to Session
commands. Multi-language Viewer outputs, account ownership, and multi-process
event brokers remain later slices.
