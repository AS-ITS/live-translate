# Changelog

## Unreleased

### Added

- Phase 2C WP1 completion pass for saved-transcript re-translation
  consistency: the application service now persists the `TranslationOutput`
  before marking the `TranslationExecution` as `completed`, so output
  persistence failure and output-created event publication failure cannot leave
  a falsely completed execution. The successful orchestration order is now
  request creation, execution creation, execution start, provider invocation,
  output creation, then execution completion. Existing repository-before-event
  publication semantics remain unchanged: repository writes and domain event
  publication are not atomic, so a completion event publication failure may
  still leave both the completed execution and output persisted. No rollback,
  retry, transaction, or compensation mechanism was introduced.
- Phase 2C WP4 Saved Transcript Re-translation HTTP API: added
  `POST /api/saved-transcripts/:sessionId/translations` with a request body
  containing `sourceLanguageCode` and `targetLanguageCode`, returning `201`
  with the serialized `request`, final `execution`, and `output` from the
  saved-transcript re-translation application service. The endpoint returns
  `503` when the optional re-translation capability is not configured. No real
  translation provider, React UI, live-session integration, or fake provider
  production wiring was added.
- Phase 2C WP3 Saved Transcript Re-translation Application Service:
  resolves canonical saved source transcript text from legacy SessionRecord
  detail, orchestrates native TranslationRequest / TranslationExecution /
  TranslationOutput creation through the command service, persists successful
  provider results and failed provider executions deterministically, and keeps
  HTTP, UI, and real provider integration out of scope.
- Phase 2C WP2 Saved Transcript Translation Provider Port: added a
  provider-neutral saved-transcript translation application port and
  deterministic fake adapter supporting configured success, rejected failure,
  synchronous throw, and deferred completion without real provider or network
  integration.
- Phase 2C WP1 Translation Persistence Foundation: repository queries for
  requests by session, executions by request, and outputs by session/request
  while preserving in-memory instance isolation and multiple output versions.
- Phase 2B-4 WP9 Translation Domain Event end-to-end integration coverage for production composition routing, lifecycle, and failure propagation.
- Phase 2B-4 WP8 Translation Domain Event handler factory with safe default no-op handlers.
- Phase 2B-4 WP7 Translation Domain Event infrastructure composition in the production application dependency graph.

## Phase 2A Foundation Completed

Phase 2A closes the foundation milestone for Live Translate. The core realtime translation workflow, transcript lifecycle, session history, saved-session export, and the first connection resilience slice are now documented as complete for the Phase 2 foundation.

This milestone intentionally keeps durable storage deferred. History remains memory-only, backend persistence is not introduced, and the next milestone is Phase 2B.

## v0.6.0 - Connection Resilience Phase 1

### Added

- Failure Classification
- Retry Policy
- Reconnect Controller
- LiveSession Failure Signal Integration
- Controlled `unexpected_close` reconnect
- Failure-State Mapping
- Manual Recovery UX
- Retry Exhaustion UX

### Improved

- Stable frontend failure handling
- Safer reconnect orchestration
- Better session lifecycle consistency
- Clearer failure UX
- Better unit/E2E coverage

### Deferred

These items are intentionally deferred:

- `token_expired` reconnect
- network reconnect
- provider reconnect
- microphone reconnect
- proactive token refresh

### Notes

- Connection Resilience is now partially implemented.
- Only `unexpected_close` supports controlled reconnect.
- Phase 2 overall remains In Progress.

## v0.5.0 - Phase 2 Foundation

### Added

- Better Transcript Handling
- Transcript Export
- Audio Input Device Selection
- Session Lifecycle Specification
- Capability-based Phase 2 planning guidance

### Changed

- Transcript state moved into dedicated transcript utility
- Transcript export added for current-session TXT/SRT/VTT
- Audio input device selection added for microphone selection
- Phase 2 planning now groups related work by capability

### Notes

- Output device selection remains future/browser-limited
- Auto Reconnect and Token Refresh are not implemented yet
- SRT/VTT timing is approximate frontend observation timing
