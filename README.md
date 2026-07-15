# Live Translate

Live Translate is a session-oriented real-time multilingual translation platform
that accepts Chinese or mixed-language speech, generates a selected target-language
output, and preserves reusable session transcripts for future translations into
additional languages. The backend owns `GEMINI_API_KEY` and issues short-lived
ephemeral tokens so the browser can connect directly to the Gemini Live API.

## Current Status

Phase 2A Foundation
Status: Completed

Phase 2 Overall
Status: In Progress

Completed:

- Phase 1 Demo
- Phase 2C - Saved Transcript Re-translation
- Phase 2D - Production Gemini Saved-Transcript Translation
- Phase 2E - Translation Provider Architecture
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

Phase 2E
Status: Completed

Phase 2E status:

- Translation Provider Registry and Provider Resolver are complete for the
  saved-transcript translation architecture.
- Production composition resolves the default Gemini provider through the
  registry/resolver path and injects it into saved-transcript retranslation.
- Final regression verified saved transcript integration, default provider
  resolution, production composition, and fake GoogleGenAI-only execution with
  no real Gemini API call or HTTP/persistence behavior change.

Documentation:

- [docs/architecture/architecture-overview.md](docs/architecture/architecture-overview.md) - High-level system architecture, runtime flow, module responsibilities, dependency boundaries, completed capabilities, and deferred architecture.
- [docs/architecture/domain-model.md](docs/architecture/domain-model.md) - Core domain objects, ownership, lifecycle, relationships, and future extension boundaries.

Planned next capability:

- Phase 2 follow-up capability selection
  - Settings
  - Usage Metrics
  - Diagnostics
  - Transcript Search
  - Storage, only if justified
