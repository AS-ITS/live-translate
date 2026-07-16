# Changelog

## Unreleased

### Added

- Phase 2K WP5 Runtime Failure Lifecycle: added Translation Command runtime
  failure handling so provider execution errors persist the created
  `TranslationExecution` as `failed`, skip `TranslationOutput` creation, avoid
  completed-state writes, and rethrow the original provider exception. Focused
  unit and production vertical integration coverage proves provider execution
  is called once, the HTTP error response keeps the existing generic internal
  error contract, repository state retains the failed execution, and successful
  production runtime persistence remains covered. No retry, timeout,
  cancellation, error classification, logging, metrics, provider resolver,
  composition, or HTTP API contract behavior was added.
- Phase 2K WP4 Production Runtime Vertical Integration: added production
  vertical integration coverage proving `POST /api/translation-executions`
  uses production composition to build the runtime execution adapter, resolves a
  deterministic translation provider through the provider resolver exactly once,
  executes the resolved provider exactly once without passing `providerKey` into
  provider input, persists exactly one `TranslationOutput`, completes the
  `TranslationExecution`, preserves explicit `providerKey`, and keeps omitted
  `providerKey` as `undefined`. No production runtime, provider resolver,
  provider implementation, HTTP API, repository, domain, retry, timeout, or
  failure-lifecycle behavior changed.
- Phase 2K WP3 Production Runtime Composition Wiring: wired production
  Translation Command composition to build a production translation execution
  provider from the existing translation provider resolver and inject only that
  execution provider into `TranslationCommandService`. Focused composition
  coverage verifies the resolver-to-runtime-provider dependency, preserves
  supplied fake execution providers for fake/test composition, and keeps saved
  transcript retranslation resolver wiring unchanged. No command service,
  runtime adapter, provider resolver, HTTP API, repository, domain, retry,
  timeout, or failure-handling behavior changed.
- Phase 2J WP5 Translation Execution Vertical Integration: added production
  vertical integration coverage proving `POST /api/translation-executions`
  executes the production-composed `FakeTranslationExecutionProvider`, creates
  exactly one `TranslationOutput` with `[fake] ${sourceText}` text, completes
  the persisted execution, preserves explicit `providerKey` metadata unchanged,
  and keeps omitted `providerKey` as `undefined`. No application, domain,
  repository, composition root, HTTP API, provider resolution, dispatcher,
  saved-transcript retranslation, persistence schema, or fake-provider behavior
  changed.
- Phase 2J WP4 Production Composition Wiring: wired production composition to
  instantiate and inject the existing `FakeTranslationExecutionProvider` into
  `TranslationCommandService`, with focused composition coverage for default
  provider injection, supplied-provider execution wiring, and preserved
  provider-omitted dispatcher behavior. No provider resolution, HTTP API,
  repository, domain model, saved-transcript retranslation, dispatcher
  implementation, or fake-provider behavior changed.
- Phase 2J WP3 Translation Execution Provider Orchestration: added
  application-layer `TranslationCommandService` orchestration for an explicitly
  injected `translationExecutionProvider`, persisting the created execution,
  invoking the provider once with source text, optional source language,
  target language, and optional provider key unchanged, creating a
  `TranslationOutput` from the provider-returned translated text, and then
  persisting the execution as completed. Existing production composition,
  dispatcher behavior, provider resolution, persistence adapters, HTTP behavior,
  saved-transcript retranslation, and fake provider implementation were left
  unchanged.
- Phase 2I WP6 Regression Validation and Closeout: completed documentation
  closeout for Translation Execution Dispatcher, marking Phase 2I complete and
  documenting `TranslationExecutionDispatcher` as the awaited asynchronous
  application-layer execution orchestration port invoked after
  `TranslationExecution` persistence. Current production composition injects
  `FakeTranslationExecutionDispatcher`, which records dispatches only; no
  provider execution, queue, scheduler, worker, background execution,
  translation, retry, persistence, execution-state update, or
  `TranslationOutput` creation occurs. `providerKey` remains metadata only,
  explicit keys are preserved, omitted keys remain `undefined`, the dispatcher
  does not resolve providers, and Saved Transcript Retranslation remains the
  only request-scoped provider-resolution flow. Focused regression validation
  covered the dispatcher port, fake dispatcher, command-service dispatch
  orchestration, composition wiring, HTTP translation command, vertical
  integration, provider metadata preservation, domain-event composition, and
  Saved Transcript Retranslation composition. No production code changed.
- Phase 2H WP7 Regression Validation and Closeout: completed documentation
  closeout for Translation Command provider attribution, marking Phase 2H
  complete and documenting that `TranslationExecution.providerKey` is optional
  metadata only, omitted keys remain `undefined`, Translation Command never
  resolves, looks up, normalizes, defaults, or falls back providers, invalid
  provider names are intentionally not validated beyond domain string/non-blank
  validation, and Saved Transcript Retranslation remains the only production
  provider-resolution path. No production behavior, domain behavior,
  repository behavior, provider resolution, persistence, saved-transcript,
  frontend, or runtime behavior changed.
- Phase 2H WP6 Translation Command Provider Metadata Vertical Integration:
  added focused integration coverage proving `POST /api/translation-executions`
  carries optional `providerKey` metadata through production composition from
  HTTP, controller, application service, domain construction, and repository
  persistence unchanged, including omitted-key `undefined` semantics. No
  provider resolution, provider lookup, fallback, normalization, validation,
  persistence migration, HTTP behavior, repository behavior, saved-transcript,
  frontend, or production code changed.
- Phase 2H WP5 Translation Command Production Composition:
  added focused production-composition coverage proving the composed
  Translation Command Controller forwards optional `providerKey` metadata
  unchanged into `TranslationCommandService.createTranslationExecution`,
  preserves omitted-key `undefined` semantics, and does not invoke provider
  resolution for the translation command path. No provider lookup, HTTP,
  persistence, saved-transcript, frontend, or domain behavior was changed.
- Phase 2H WP4 Translation Command HTTP API Provider Metadata Input:
  documented focused HTTP-boundary coverage proving
  `POST /api/translation-executions` forwards optional `providerKey` metadata
  unchanged into `TranslationCommandController.createTranslationExecution`,
  preserves omitted-key `undefined` semantics, and does not validate invalid
  provider metadata at the HTTP layer. No provider resolution, persistence,
  saved-transcript, frontend, or environment behavior was changed.
- Phase 2H WP3 Translation Command Controller Provider Metadata Input:
  kept the non-HTTP Translation Command Controller create-execution boundary as
  an unchanged pass-through into `TranslationCommandService.createTranslationExecution`,
  with focused coverage proving optional `providerKey` metadata is forwarded
  exactly as received, omitted keys are not defaulted, invalid values are not
  validated by the controller, and service results/errors remain unchanged. No
  HTTP API, repository, provider resolver, provider registry, composition,
  persistence, saved-transcript, provider implementation, or frontend behavior
  was changed.
- Phase 2H WP2 Translation Command Service Provider Metadata Input:
  made the Translation Command Service create-execution path explicitly forward
  optional `providerKey` metadata into the Translation Execution domain model,
  preserving omitted-key behavior and leaving provider-key validation solely in
  the domain. No HTTP API, repository, provider resolver, provider registry,
  composition, persistence, saved-transcript, or frontend behavior was changed.
- Phase 2H WP1 Translation Execution Provider Metadata Domain Contract:
  added optional immutable `providerKey` attribution to the Translation
  Execution domain model with string/non-blank validation, omitted-key support,
  and lifecycle transition preservation. No persistence, HTTP API, provider
  resolution, composition, provider implementation, read-model, repository, or
  saved-transcript retranslation behavior was changed.
- Phase 2G WP7 Regression Validation and Closeout: completed documentation
  closeout for Request-Scoped Provider Selection, marking Phase 2G complete and
  documenting saved-transcript HTTP `providerKey` support, explicit request
  override behavior, environment-backed default provider selection when omitted,
  existing unknown-provider registry error propagation, and no provider
  fallback semantics. No production behavior changed and automated regression
  validation is deferred to manual execution.
- Phase 2G WP6 HTTP Integration Provider Selection: added production HTTP
  integration coverage proving saved-transcript retranslation performs
  request-scoped provider selection from the optional request `providerKey`,
  where explicit `fake` overrides configured `TRANSLATION_PROVIDER=gemini`,
  omitted provider selection resolves the configured Gemini default, and an
  unknown provider propagates the existing registry error without fallback,
  provider execution, SDK use, or translation command persistence. No
  production code changed.
- Phase 2G WP5 Request-Scoped Provider Resolution Wiring: moved production
  saved-transcript retranslation provider selection from startup-time provider
  injection to a request-scoped resolver dependency, forwarding explicit and
  omitted `providerKey` values into the existing translation provider
  resolution composition with the shared configuration object, preserving
  default-provider ownership, exact resolved-provider pass-through,
  resolution-error propagation, and existing successful persistence/event
  ordering with no HTTP parsing, resolver, registry, provider implementation,
  persistence schema, retry, fallback, or frontend behavior changes.
- Phase 2G WP4 HTTP API Provider Selection Input: extended the saved
  transcript retranslation HTTP request boundary to accept optional
  `providerKey` and forward it unchanged to the existing service/controller
  call while preserving omitted-key behavior and avoiding resolver,
  composition, provider, persistence, retry, fallback, environment, frontend,
  and domain changes.
- Phase 2G WP3 Saved Transcript Retranslation Provider Selection Input:
  threaded optional `providerKey` input through the production saved-transcript
  retranslation composition boundary into the existing translation provider
  resolution composition, preserving configuration-object forwarding, resolved
  provider identity, default-provider resolver ownership, and unchanged
  resolution error propagation with no HTTP, provider, registry, resolver,
  persistence, retry, environment-variable, frontend, or Gemini behavior
  changes.
- Phase 2G WP1 Resolver Explicit Provider Selection: extended
  `TranslationProviderResolver` request-level selection so an optional explicit
  `providerKey` takes precedence over `configuration.defaultProviderKey`,
  validates explicit keys for string type and blankness only, delegates exact
  provider lookup and unknown-provider errors unchanged to
  `TranslationProviderRegistry`, and preserves configuration-driven default
  resolution with no HTTP, composition root, provider implementation,
  persistence, frontend, retry, fallback, or runtime provider management
  changes.
- Phase 2F WP7 Translation Provider Configuration closeout: completed the
  focused regression verification for configuration-driven provider resolution,
  documenting that the environment-backed configuration factory selects the
  default provider key, defaults to `gemini` when `TRANSLATION_PROVIDER` is
  unset, preserves explicit `TRANSLATION_PROVIDER=gemini`, and passes the
  shared configuration object through production composition into
  `TranslationProviderResolver`. Production composition now owns creation of the
  shared provider configuration, the resolver consumes the configuration object,
  composition no longer extracts `defaultProviderKey`, and explicit Gemini
  production HTTP integration was verified through fake GoogleGenAI only with
  no real Gemini API calls and no HTTP, persistence, domain, frontend, retry, or
  fallback behavior changes.
- Phase 2F WP6 Configuration-driven Provider Resolution Integration
  Verification: extended production saved-transcript HTTP integration coverage
  to prove explicit `TRANSLATION_PROVIDER=gemini` is consumed by the shared
  translation provider configuration factory, passed as the full configuration
  object into provider-resolution composition, resolved once through
  `TranslationProviderResolver` and `TranslationProviderRegistry`, injected into
  `SavedTranscriptRetranslationService`, invoked once through the Gemini
  provider and fake GoogleGenAI client, and preserves the existing `201`
  response and translation persistence shape with no real Gemini API call or
  production code changes.
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
