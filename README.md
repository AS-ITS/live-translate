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
- Phase 2F - Translation Provider Configuration
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

Phase 2F
Status: Completed

Phase 2F status:

- Translation provider selection is controlled by environment-driven
  configuration through
  `createTranslationProviderConfiguration({ environment })`.
- Set `TRANSLATION_PROVIDER=gemini` to select the current production provider.
  When unset, the default provider key is `gemini`.
- Environment configuration determines the default translation provider key.
  The resolver consumes the shared configuration object and resolves the
  registered provider before the Saved Transcript Retranslation service is
  constructed.
- The configuration layer only stores the provider key. It does not validate
  whether that provider exists in the registry.
- The registry owns provider registration, the resolver owns provider
  selection, and the service depends only on the resolved provider.
- Runtime provider switching, per-request provider selection, fallback, retry,
  provider health checks, and frontend provider controls are not supported.
- Focused regression verified explicit `TRANSLATION_PROVIDER=gemini`, the
  default `gemini` provider path, production HTTP `201` behavior, persistence,
  and fake GoogleGenAI-only execution with no real Gemini API call.

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
