# Changelog

## Unreleased

### Added

- Phase 2F WP5 Saved Transcript Retranslation Composition Migration:
  moved saved-transcript provider-resolution composition ownership fully to the
  shared translation provider configuration object by removing the composition
  guard that extracted `configuration.defaultProviderKey`, keeping production
  saved-transcript composition passing the configuration object into provider
  resolution and resolving through `TranslationProviderResolver` with no HTTP,
  persistence, provider, Gemini, retry, fallback, frontend, or API behavior
  changes.
- Phase 2F WP4 Translation Provider Configuration HTTP/API Integration:
  moved the production HTTP saved-transcript translation provider-resolution
  handoff to pass the shared translation provider configuration object instead
  of an extracted provider key, updated the provider-resolution composition
  adapter to construct the configured resolver from that object while
  preserving its registered-default guard, and verified the HTTP path still
  resolves once, invokes the selected provider once, returns the same response
  shape, and preserves persistence behavior with no Gemini, frontend, retry, or
  fallback changes.
- Phase 2F WP3 Translation Provider Resolver Configuration Integration:
  refactored the translation provider resolver constructor to consume
  `configuration.defaultProviderKey` instead of a direct `defaultProviderKey`
  option, removed construction-time default-provider registry existence
  checks from the resolver, adapted the existing provider-resolution
  composition boundary to pass a configuration object while preserving its
  default-provider guard, and preserved explicit provider resolution,
  configured default resolution, registry error propagation, no-fallback
  behavior, provider identity, immutability, and
  non-HTTP/non-Gemini/non-persistence behavior.
- Phase 2F WP2 Translation Provider Configuration Composition: wired the
  environment-backed translation provider configuration into production
  saved-transcript provider composition so provider resolution receives
  `configuration.defaultProviderKey` instead of a hardcoded default, while
  keeping registry, resolver, service API, HTTP API, Gemini provider behavior,
  translation logic, retry, fallback, runtime provider switching, database, and
  frontend behavior unchanged.
- Phase 2F WP1 Translation Provider Configuration: added a standalone
  immutable environment-backed configuration factory for selecting the default
  translation provider key from `TRANSLATION_PROVIDER`, defaulting to `gemini`
  when unset and preserving configured provider keys without validating provider
  existence. Resolver, registry, production composition, HTTP API, Gemini
  provider behavior, runtime provider switching, fallback, retry, SDK loading,
  and real Gemini API usage remain unchanged.
- Phase 2E WP7 closeout and final regression: completed the full Translation
  Provider architecture regression suite for the registry, resolver,
  composition, saved-transcript integration, and production Gemini HTTP path.
  The suite verified the default Gemini provider resolution path through the
  controller, saved-transcript retranslation service, resolver, registry,
  Gemini provider, Gemini client adapter, and fake GoogleGenAI client with one
  resolver call, one registry lookup, one provider invocation, one
  `generateContent` call, no skipped tests, no real Gemini API call, and no
  HTTP, persistence, controller, retry, fallback, provider interface, frontend,
  or production behavior change. Phase 2E is complete.
- Phase 2E WP6 Provider Resolution End-to-End Verification: extended the
  production saved-transcript HTTP end-to-end test to prove the composed Gemini
  provider is registered, resolved once with no provider key through the
  configured default provider, injected unchanged into the retranslation
  service, invoked once with unchanged inputs, and forwarded through the Gemini
  client adapter to a fake GoogleGenAI `generateContent` call exactly once while
  preserving the Phase 2D `201` response body and persisted request,
  execution, and output state with no real Gemini API call or production code
  behavior change.
- Phase 2E WP5 Saved Transcript Provider Resolution Integration verification:
  added focused production HTTP integration coverage proving saved-transcript
  retranslation resolves the configured Gemini provider through the translation
  provider resolver and registry, injects that resolved provider into the
  application service, invokes provider translation and fake GoogleGenAI
  content generation exactly once, and preserves the existing API response
  contract with no runtime provider switching, fallback, retry, persistence,
  controller, UI, or real Google API behavior changes.
- Phase 2E WP4 Saved Transcript Provider Resolution Integration: activated
  translation provider resolution in production saved-transcript retranslation
  composition by registering the composed Gemini provider, resolving the
  configured default provider once during composition, and injecting that
  resolved provider unchanged into the application service. No HTTP, provider,
  persistence, retry, fallback, runtime switching, UI, or real Gemini API
  behavior was introduced.
- Phase 2E WP3 Translation Provider Resolution Composition: added a focused
  infrastructure composition factory that assembles the translation provider
  registry and resolver through the existing WP1/WP2 factories, verifies
  default and explicit provider resolution, preserves provider identity and
  exact provider-key behavior, and remains inactive in production runtime flows
  with no real Gemini API calls.
- Phase 2E WP2 Translation Provider Resolver: added a standalone
  infrastructure resolver that selects an explicitly requested translation
  provider key or the configured registered default provider key, delegates
  exact provider lookup to the registry without normalization, validates
  dependencies and resolve options synchronously, and exposes a frozen
  `resolve`-only API. The resolver returns provider instances without invoking
  translation and does not add runtime composition, HTTP wiring, fallback,
  retries, SDK construction, environment loading, persistence, or real Gemini
  API behavior.
- Phase 2E WP1 Translation Provider Registry: added a standalone
  infrastructure registry contract for validating and looking up registered
  translation providers by exact provider key, with frozen `get`/`has`/`list`
  API surface and focused unit coverage. Resolver, runtime, metadata,
  production composition wiring, HTTP wiring, and Gemini provider registration
  remain deferred.
- Phase 2D WP7 final verification and closeout: completed the focused
  regression pass for WP1-WP6 production Gemini saved-transcript translation,
  confirming provider contract behavior, Gemini client adapter forwarding,
  GoogleGenAI construction, production composition, and HTTP end-to-end flow
  with fake SDK clients only. Phase 2D is complete with no real Gemini API
  execution, public API changes, persistence changes, HTTP contract changes,
  React changes, retry behavior, streaming behavior, or production behavior
  expansion.
- Phase 2D WP6 end-to-end Gemini translation flow verification: added focused
  integration coverage proving the production saved-transcript HTTP command path
  composes through the controller, application service, production Gemini
  provider, client adapter, and fake Google GenAI SDK client, invoking
  `generateContent` exactly once while forwarding the configured model, prompt
  context, transcript text, source language, and target language without real
  Gemini API calls or production behavior changes.
- Phase 2D WP5 production Gemini integration verification: added focused
  integration coverage for the saved-transcript HTTP path through production
  Gemini composition into the Google GenAI SDK adapter shape, including
  dependency invocation counts, request shape, result mapping, and exact
  `generateContent` failure propagation with no retry or fallback behavior.
- Phase 2D WP4 production Gemini saved-transcript provider activation: added
  production composition-root wiring from Gemini environment, GoogleGenAI SDK
  client, Gemini client adapter, and Gemini saved-transcript provider
  composition into the saved-transcript re-translation application service,
  with focused unit coverage and no HTTP, persistence, provider, prompt, retry,
  fallback, or UI behavior changes.
- Phase 2D WP3 GoogleGenAI construction and Gemini saved-transcript provider
  composition: added focused official `GoogleGenAI` SDK client construction,
  a production-facing Gemini saved-transcript translation composition factory
  that reuses the WP1 provider plus WP2 environment and client adapter, and
  focused unit coverage. Production application composition-root wiring,
  HTTP activation, UI wiring, live-session flow, persistence, and real Gemini
  network flow remain deferred.
- Phase 2D WP2 Gemini client adapter and environment configuration: added a
  frozen infrastructure adapter that delegates directly to
  `client.models.generateContent(request)` without transformation, retry,
  timeout, logging, or SDK construction, plus deterministic `GEMINI_API_KEY`
  and `GEMINI_MODEL` validation for future saved-transcript provider
  composition. This does not wire the adapter into production composition,
  HTTP endpoints, application services, UI, persistence, or runtime
  translation flow.
- Phase 2D WP1 Gemini saved-transcript translation provider contract: added a
  Gemini-specific infrastructure factory with injected client, model, and prompt
  builder dependencies, deterministic request construction, response
  normalization, and focused error boundaries. This does not add real Gemini API
  integration, production composition wiring, environment configuration, SDK
  initialization, or network calls.
- Phase 2C Saved Transcript Re-translation closeout: marked the capability as
  completed after focused provider, application service, composition, HTTP,
  event-ordering, failure-boundary, immutability, and export-surface
  verification. The completed boundary remains deterministic and scoped; no
  real external provider, UI, retry, rollback, transaction, compensation, or
  deployment behavior is included.
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
