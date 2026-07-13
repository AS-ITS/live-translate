# Live Translate

Live Translate is a real-time speech translation web app using a React frontend,
a Node.js backend, and the Gemini Live API. The backend owns `GEMINI_API_KEY` and
issues short-lived ephemeral tokens so the browser can connect directly to the
Gemini Live API.

## Current Status

Phase 2A Foundation
Status: Completed

Phase 2 Overall
Status: In Progress

Completed:

- Phase 1 Demo
- Real-time Gemini Live translation
- Ephemeral token flow
- Transcript handling
- Transcript export
- Audio input device selection
- Session lifecycle specification
- Connection resilience foundation
- Session records and history MVP
- Saved-session export
- Security hardening
- Testing documentation

Documentation:

- [docs/architecture/architecture-overview.md](docs/architecture/architecture-overview.md) - High-level system architecture, runtime flow, module responsibilities, dependency boundaries, completed capabilities, and deferred architecture.

Planned next capability:

- Phase 2B
  - Settings
  - Usage Metrics
  - Diagnostics
  - Transcript Search
  - Storage, only if justified
