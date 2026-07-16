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
- Phase 2G - Request-Scoped Provider Selection
- Phase 2H - Translation Command Provider Attribution
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

Phase 2G
Status: Completed

Phase 2G status:

- Saved Transcript Retranslation supports request-scoped provider selection.
- The HTTP retranslation request accepts optional `providerKey`.
- When `providerKey` is supplied, it is forwarded through the controller,
  service, production provider-resolution composition, resolver, and registry,
  and it overrides the configured default provider for that request.
- When `providerKey` is omitted, provider resolution uses the environment-backed
  default from `TRANSLATION_PROVIDER`; when unset, the default provider key is
  `gemini`.
- The configuration layer only stores the provider key. It does not validate
  whether that provider exists in the registry.
- Unknown providers propagate the existing registry error. There is no provider
  fallback, retry behavior, provider health check, runtime provider switching,
  additional production provider activation, or frontend provider control.
- Focused HTTP integration coverage verified explicit provider override,
  omitted-provider default behavior, persistence on success, no persistence on
  provider-resolution failure, and fake GoogleGenAI-only Gemini execution with
  no real Gemini API call.

Phase 2H
Status: Completed

Phase 2H status:

- `TranslationExecution` can optionally store `providerKey` as provider
  attribution metadata.
- Translation Command accepts and persists `providerKey` without resolving,
  looking up, normalizing, or defaulting providers.
- When `providerKey` is omitted, it remains `undefined`.
- Invalid provider names are intentionally not resolved or checked by the
  Translation Command path; only the domain string/non-blank validation applies
  when a value is supplied.
- Saved Transcript Retranslation remains the only production path that performs
  provider resolution through the provider-resolution composition, resolver,
  and registry.
- Focused HTTP, composition, and vertical integration coverage verified
  provider metadata propagation from request input through controller, service,
  domain construction, and repository persistence with no production behavior,
  persistence, provider-resolution, or saved-transcript behavior changes.

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
