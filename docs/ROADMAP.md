# ROADMAP

This document helps AI coding agents and developers understand the intended
project phases, current scope, and boundaries for future work.

## 1. Project Direction

This project is intended to evolve in the following order:

1. Phase 1 Demo
2. Phase 2 Internal Tool
3. Phase 3 Production

Each phase should build on the previous phase without expanding scope unless explicitly requested.

## 2. Current Status

Current milestone: Phase 3C Durable Queue Foundation completed.

Phase 1 Demo is completed. Phase 2A Foundation is completed. Phase 2 overall is
in progress and not completed. Phase 2C Saved Transcript Re-translation,
Phase 2D Production Gemini Saved-Transcript Translation, and Phase 2E
Translation Provider Architecture are completed. Phase 2F Translation Provider
Configuration is completed. Phase 2G Request-Scoped Provider Selection is
completed. Phase 2H Translation Command Provider Attribution is completed.
Phase 2I Translation Execution Dispatcher is completed. Phase 2K Production
Translation Runtime is completed. Phase 2L Execution Reliability is completed.
Phase 2M Runtime Provider Resolution is completed. Phase 2N Gemini Translation
Execution Provider is completed. Phase 2O Production Gemini Translation
Execution is completed. Phase 2P Translation Execution Lifecycle is completed.
Phase 3A Async Execution Runtime is completed. Phase 3B WP1 Queue Abstraction,
WP2 Worker Runtime Lifecycle, WP3 Worker Loop, and WP4 Graceful Shutdown are
completed. Phase 3B WP5 Runtime Integration and WP6 Documentation Closeout are
completed. Phase 3C WP1 Queue Port, WP2 Repository Contract, WP3 File
Repository, WP4 Feature-gated Composition, WP5 Dual-write Enqueue, WP6 Startup
Recovery, and WP7 Documentation are completed.

Completed Phase 1 capabilities include:

- React frontend
- Node.js backend
- Gemini Live API integration
- Ephemeral token flow
- Real-time speech translation
- Target language selection
- Input/output transcripts
- Translated audio playback
- Start / Stop session
- Basic error handling
- Security hardening
- Testing documentation
- P0 hardening tests passed

Phase 2A Foundation completed:

- Transcript Engine
  - Better Transcript Handling
  - Transcript Export
- Audio Input Management
  - Audio Input Device Selection
- Session Design
  - Session Lifecycle Specification
- Connection Resilience
  - Failure Classification
  - Retry Policy
  - Reconnect Controller
  - Controlled `unexpected_close` reconnect
  - Failure-state mapping
- Session Records & Translation History
  - Session Records
  - History List
  - Session Detail
  - Saved Session Export

## 3. Phase 1 - Demo

Status: Completed

### Scope

- Real-time speech translation
- Target language selection
- Subtitle display
- Translated audio playback
- Start / Stop
- Local or controlled demo usage

### Non-Scope

- Login
- Database
- Dashboard
- Multi-user
- Persistent transcript history
- Payment
- Deployment automation

## 4. Phase 2 - Internal Tool

Status: In Progress. Phase 2A Foundation is completed; Phase 2B-1 Architecture
Foundation is current.

### Candidate Features

- Basic login / access control
- Translation history. Deferred beyond the foundation milestone.
- Export transcript as TXT / SRT / VTT. Completed.
- Audio input device selection. Completed.
- Audio output device selection. Deferred.
- Recent target language. Deferred.
- Session history. Completed as the Phase 2A MVP.
- Session Lifecycle Specification. Completed.
- Connection Resilience. Phase 1 completed; depends on Session Lifecycle
  Specification.
  - Failure Classification
  - Retry Policy
  - Reconnect Controller
  - Controlled `unexpected_close` reconnect
  - Failure-state mapping
- AudioWorklet migration. Deferred.
- Better transcript handling. Completed.
- Usage logging. Deferred.
- Admin usage review. Deferred.

### Phase 2A Foundation

Completed:

- Transcript Engine
- Transcript Export
- Audio Input Device Selection
- Session Lifecycle
- Connection Resilience Phase 1
- Session Records
- History List
- Session Detail
- Saved Session Export

Deferred:

- Durable storage
- Backend persistence
- Search
- Bookmarks
- Delete
- Analytics
- Diagnostics dashboard
- Access control
- Token refresh
- Proactive reconnect
- Network reconnect
- Microphone reconnect
- Provider reconnect
- Settings
- Usage Metrics
- Diagnostics
- Transcript Search
- Audio Output Selection
- AudioWorklet migration

### Current Phase 2 Feature Status

- Phase 1 Demo: Completed
- Transcript Engine: Completed
  - Better Transcript Handling
  - Transcript Export
- Audio Input Management: Completed
  - Audio Input Device Selection
- Session Design: Completed
  - Session Lifecycle Specification
- Connection Resilience: Phase 1 Completed
  - Failure Classification
  - Retry Policy
  - Reconnect Controller
  - Controlled `unexpected_close` reconnect
  - Failure-state mapping
- Session Records & Translation History: MVP Completed
  - Session Records
  - History List
  - Session Detail
  - Saved Session Export
- Production Gemini Saved-Transcript Translation: Completed
  - Gemini saved-transcript provider contract
  - Gemini client adapter and environment validation
  - GoogleGenAI SDK client construction
  - Production provider composition
  - Production HTTP integration verification
  - End-to-end flow verification with fake GoogleGenAI clients
- Translation Provider Architecture: Completed
  - Translation Provider Registry
  - Provider Resolver
  - Production Composition
  - Default Provider Resolution
  - Saved Transcript Integration
- Phase 2F - Translation Provider Configuration: Completed
  - Configuration factory
  - Environment default provider selection
  - Production composition wiring
  - Resolver configuration ownership
  - Shared configuration propagation
  - Explicit Gemini production HTTP verification
  - Focused regression closeout
- Phase 2G - Request-Scoped Provider Selection: Completed
  - HTTP `providerKey` input for saved-transcript retranslation
  - Explicit provider override through request-scoped resolution
  - Omitted-provider behavior using `TRANSLATION_PROVIDER` default selection
  - Existing registry error propagation for unknown providers
  - No provider fallback semantics
  - Production HTTP integration verification
- Phase 2H - Translation Command Provider Attribution: Completed
  - Optional `TranslationExecution.providerKey` metadata
  - Translation Command HTTP, controller, service, domain, and persistence
    propagation
  - Omitted `providerKey` remains `undefined`
  - Provider names are not resolved, normalized, defaulted, or looked up by
    Translation Command
  - Invalid provider names are intentionally not validated beyond domain
    type/non-blank validation
  - Saved Transcript Retranslation remains the only provider-resolution path
  - Focused HTTP, composition, and vertical integration verification
- Phase 2I - Translation Execution Dispatcher: Completed
  - Application-layer execution orchestration port
  - Asynchronous dispatch after `TranslationExecution` persistence
  - Dispatch is awaited before request completion
  - Current production composition uses a fake recording dispatcher only
  - No provider execution, queue, scheduler, worker, or background execution
  - Focused dispatcher, composition, HTTP, vertical integration, provider
    metadata, domain-event composition, and saved-transcript composition
    verification
- Phase 2K - Production Translation Runtime: Completed
  - Production Runtime Port
  - Production Runtime Adapter
  - Production Composition Wiring
  - Runtime Vertical Integration
  - Runtime Failure Lifecycle
- Phase 2L - Execution Reliability: Completed
  - RetryPolicy abstraction
  - TranslationExecutionRunner
  - Retry execution
  - Exhausted retry semantics
  - Production composition wiring
  - Production vertical integration
- Phase 2M - Runtime Provider Resolution: Completed
  - TranslationExecutionProviderResolver application boundary
  - Resolver-backed Translation Command runtime execution
  - Default runtime provider behavior
  - Deterministic unknown-provider failure behavior
  - Focused unit and vertical integration verification
- Phase 2N - Gemini Translation Execution Provider: Completed
  - Production `GeminiTranslationExecutionProvider`
  - `GeminiClient` request construction and response normalization
  - Production composition wiring for `GEMINI_API_KEY` and `GEMINI_MODEL`
  - Runtime `gemini` provider registration
  - Gemini HTTP failure mapping for 400, 401, 403, 429, 5xx, and invalid
    responses
  - Fake HTTP vertical integration verification with no real Gemini API call
- Phase 2O - Production Gemini Translation Execution: Completed
  - Gemini `TranslationExecutionProvider`
  - Production composition defaulting to `gemini`
  - Unit, composition, vertical integration, and error integration coverage
  - Fake provider path preserved for test composition
- Phase 2P - Translation Execution Lifecycle: Completed
  - `created`, `queued`, `running`, `completed`, and `failed` execution states
  - Success lifecycle persisted as `created -> queued -> running -> completed`
  - Failure lifecycle persisted as `created -> queued -> running -> failed`
  - Focused domain, application service, and vertical integration verification
- Phase 3A - Async Execution Runtime: Completed
  - Execution Queue
  - Async Submission
  - TranslationExecutionWorker
  - Repository Lookup
  - Production Composition
  - HTTP Contract
  - Success Vertical Integration
  - Failure Vertical Integration
  - Worker Runtime
  - Current limitations: in-memory queue, Worker Runtime not automatically
    started, no durable queue, no cancellation, no timeout, and no multi-worker
    coordination
- Phase 3C - Durable Queue Foundation: Completed
  - WP1 Queue Port
  - WP2 Repository Contract
  - WP3 File Repository
  - WP4 Feature-gated Composition
  - WP5 Dual-write Enqueue
  - WP6 Startup Recovery
  - WP7 Documentation
  - Current limitations: replay removes durable items immediately after active
    enqueue, no acknowledgement, no replay deduplication, no lease, no
    visibility timeout, no retry, no dead-letter queue, no multi-worker
    support, and no locking
- Phase 2 overall: In Progress, Phase 2P Translation Execution Lifecycle completed

### Phase 2 Planning Rule

Phase 2 capabilities should be grouped logically. Planning should prefer
capability specs that support related work instead of creating a new feature
spec for every small feature.

Completed capabilities:

- Transcript Engine
  - Better Transcript Handling
  - Transcript Export
- Audio Input Management
  - Audio Input Device Selection
- Session Design
  - Session Lifecycle Specification
- Connection Resilience
  - Failure Classification
  - Retry Policy
  - Reconnect Controller
  - Controlled `unexpected_close` reconnect
  - Failure-state mapping
- Session Records & Translation History
  - Session Records
  - History List
  - Session Detail
  - Saved Session Export
- Production Gemini Saved-Transcript Translation
  - Provider contract
  - Client adapter
  - SDK construction
  - Production composition
  - Production integration verification
  - End-to-end flow verification
- Translation Provider Architecture
  - Translation Provider Registry
  - Provider Resolver
  - Production Composition
  - Default Provider Resolution
  - Saved Transcript Integration
- Translation Provider Configuration
  - Configuration factory
  - Environment default provider selection
  - Production composition wiring
  - Resolver configuration ownership
  - Shared configuration propagation
  - Explicit Gemini production HTTP verification
  - Focused regression closeout
- Request-Scoped Provider Selection
  - HTTP `providerKey` support
  - Explicit provider override
  - Environment default behavior when omitted
  - Unknown-provider registry error propagation
  - No fallback semantics
  - HTTP integration verification
- Translation Command Provider Attribution
  - Optional `TranslationExecution.providerKey` metadata
  - Metadata-only propagation through Translation Command
  - No Translation Command provider resolution or registry interaction
  - Omitted-key `undefined` semantics
  - HTTP, composition, and vertical integration verification
- Translation Execution Dispatcher
  - Application-layer execution orchestration port
  - Awaited asynchronous dispatch after execution persistence
  - Fake production dispatcher records dispatches only
  - No provider execution, queue, scheduler, worker, or background execution
  - Focused regression closeout
- Production Translation Runtime
  - Production Runtime Port
  - Production Runtime Adapter
  - Production Composition Wiring
  - Runtime Vertical Integration
  - Runtime Failure Lifecycle
- Execution Reliability
  - RetryPolicy abstraction
  - TranslationExecutionRunner
  - Retry execution
  - Exhausted retry semantics
  - Production composition wiring
  - Production vertical integration
- Runtime Provider Resolution
  - TranslationExecutionProviderResolver application boundary
  - Provider resolution before execution-provider invocation
  - Default provider behavior for omitted `providerKey`
  - Deterministic unknown-provider failure lifecycle
  - Focused unit and vertical integration verification
- Gemini Translation Execution Provider
  - Production Gemini execution provider
  - Gemini HTTP client request/response handling
  - Gemini runtime composition registration
  - Fake HTTP integration verification
  - Failure mapping closeout
- Production Gemini Translation Execution
  - `GeminiTranslationExecutionProvider` adapter integration
  - Production `gemini` provider default
  - Unit and composition verification
  - Vertical integration and error integration verification
  - Fake provider path preserved
- Translation Execution Lifecycle
  - Explicit `TranslationExecution` statuses: `created`, `queued`, `running`,
    `completed`, and `failed`
  - Success lifecycle: `created -> queued -> running -> completed`
  - Failure lifecycle: `created -> queued -> running -> failed`
  - Focused domain, application service, and vertical integration closeout

Future provider capabilities remain separate future work:

- Runtime provider switching
- Fallback and retry
- Provider health checks
- Additional production providers
- Frontend provider controls

### Phase 2B-1 - Architecture Foundation

Status: Current.

Scope:

- Documentation and contracts only.
- Application Layer boundaries.
- Aggregate boundaries.
- Repository and provider ports.
- TranslationRequest / TranslationExecution / TranslationOutput contracts.
- Compatibility Adapter placement.
- Read-model contracts.
- Lightweight domain event contracts.

No production code changes and no tests are required for this documentation-only
phase.

### Phase 2B-2 - Foundation Implementation

Status: Planned.

Scope:

- Application service skeletons:
  - `SessionApplicationService`
  - `TranslationApplicationService`
  - `ExportApplicationService`
- Repository ports:
  - `SessionRepository`
  - `TranslationRepository`
- Provider ports:
  - `LiveSpeechTranslationPort`
  - `SavedTranscriptTranslationPort`
- Compatibility Adapter implementation in repository implementation or
  read-model mapper.
- Read-model wrappers:
  - `SessionHistoryListItem`
  - `SessionDetailDTO`
  - `TranslationOutputSummaryDTO`
  - `TranslationOutputDetailDTO`
  - `TranslationRequestDTO`
  - `TranslationExecutionDTO`
- Current UI single-output display must continue to work.

### Phase 2C - Saved Transcript Re-translation

Status: Completed.

Scope:

- Saved transcript translation provider port.
- Deterministic fake saved transcript provider.
- Saved transcript re-translation application service.
- TranslationCommandService orchestration.
- Request, execution, and output persistence.
- Translation domain event publication.
- Production dependency composition.
- HTTP request handling.
- Public translation application export surface.
- Partial-failure ordering correction so output creation occurs before the
  execution is marked completed.
- Focused production contract verification.

Deferred:

- Provider selection beyond the production Gemini saved-transcript provider.
- Retry.
- Cancel.
- Delete.
- Provider selection UI.
- Output version UI.
- Transaction, rollback, compensation, or retry semantics.

### Phase 2D - Production Gemini Saved-Transcript Translation

Status: Completed.

Scope:

- Gemini saved-transcript translation provider contract.
- Gemini client adapter and environment configuration validation.
- GoogleGenAI SDK client construction.
- Production saved-transcript provider composition.
- Production composition-root activation.
- Focused production integration verification.
- End-to-end HTTP-to-provider flow verification using fake GoogleGenAI clients.

Closeout:

- Final focused regression verification completed for WP1-WP6.
- Production Gemini path is available through the existing saved-transcript
  re-translation application stack.
- No real Gemini API call was performed during automated verification.
- No public API, persistence, HTTP contract, React, retry, streaming, logging,
  metrics, or database behavior was added as part of closeout.

Deferred:

- Real Gemini smoke execution.
- Retry behavior.
- Streaming saved-transcript translation.
- Authentication and authorization changes.
- Durable persistence or database schema changes.
- UI activation or output version UI.

### Phase 2E - Translation Provider Architecture

Status: Completed.

Scope:

- Translation Provider Registry contract for exact provider-key registration,
  lookup, listing, and provider identity preservation.
- Provider Resolver contract for default provider resolution and explicit
  provider selection without key normalization or fallback on explicit miss.
- Production Composition that registers the Gemini saved-transcript provider,
  resolves the configured default provider once, and injects the resolved
  provider into the saved-transcript retranslation service.
- Default Provider Resolution using Gemini for saved-transcript translation.
- Saved Transcript Integration through the existing HTTP controller,
  SavedTranscriptRetranslationService, TranslationProviderResolver,
  TranslationProviderRegistry, GeminiSavedTranscriptTranslationProvider,
  GeminiClientAdapter, GoogleGenAIClient, and fake GoogleGenAI test client.

Closeout:

- Final Phase 2E regression suite completed with all tests passing and no
  skipped tests.
- Production saved-transcript flow verified one resolver call, one registry
  lookup, one provider translation invocation, and one fake GoogleGenAI
  `generateContent` call.
- HTTP response schema, status code, SessionRecord persistence,
  TranslationOutput persistence, controller behavior, retry behavior, fallback
  behavior, provider interface, and frontend behavior remain unchanged.
- Automated verification used fake GoogleGenAI clients only; no real Gemini API
  call was performed.

Deferred:

- Runtime provider switching.
- Multiple providers.
- Provider configuration UI.
- Provider retries, fallback, metrics, health checks, caching, priorities, or
  load balancing.
- Real Gemini integration testing.

### Phase 2H - Translation Command Provider Attribution

Status: Completed.

Scope:

- Optional immutable `providerKey` attribution on `TranslationExecution`.
- Translation Command create-execution input accepts `providerKey` as metadata
  and forwards it through HTTP, controller, application service, domain
  construction, and repository persistence.
- Omitted `providerKey` remains `undefined`.
- Provider names are not normalized, defaulted, looked up, or resolved by the
  Translation Command path.
- Invalid provider names are intentionally not validated by HTTP, controller,
  service, composition, repository, or provider infrastructure; when supplied,
  the domain only enforces string and non-blank semantics.
- Saved Transcript Retranslation remains the only production path that performs
  provider resolution through provider-resolution composition, resolver, and
  registry.

Closeout:

- Focused regression coverage completed for WP1-WP6.
- HTTP, production-composition, and vertical integration tests verify
  `providerKey` propagation and omitted-key behavior.
- No production behavior, provider resolution, provider lookup, fallback,
  domain lifecycle, repository behavior, persistence migration,
  saved-transcript behavior, or frontend behavior changed during closeout.

Deferred:

- Runtime provider switching from Translation Command.
- Provider validation in Translation Command.
- Provider lookup, fallback, retry, health check, or registry interaction from
  Translation Command.

### Phase 2I - Translation Execution Dispatcher

Status: Completed.

Scope:

- `TranslationExecutionDispatcher` is the application-layer execution
  orchestration port for execution creation.
- Dispatch is asynchronous and is invoked immediately after
  `TranslationExecution` repository persistence.
- `TranslationCommandService` awaits dispatch completion before the request
  completes.
- The dispatcher receives the original persisted `TranslationExecution`
  instance.
- The dispatcher return value is ignored.
- Dispatcher errors propagate unchanged through the command path.

Current production composition:

- Production composition currently injects
  `FakeTranslationExecutionDispatcher`.
- The fake dispatcher records dispatches only.
- No provider execution occurs.
- No queue exists.
- No scheduler exists.
- No worker exists.
- No background execution exists.

Current create-execution ordering:

```text
create TranslationExecution
↓
repository persistence
↓
TranslationExecutionDispatcher.dispatch()
↓
existing domain-event publication
↓
request completes
```

Dispatch occurs after persistence and is awaited. It does not change execution
state, create `TranslationOutput`, or resolve providers.

Provider metadata:

- `providerKey` remains metadata only.
- Explicit `providerKey` values are preserved.
- Omitted `providerKey` remains `undefined`.
- The dispatcher does not resolve providers.
- Saved Transcript Retranslation remains the only request-scoped
  provider-resolution flow.

Current limitations:

- The dispatcher performs no execution.
- The dispatcher performs no translation.
- The dispatcher performs no retries.
- The dispatcher performs no scheduling.
- The dispatcher performs no queueing.
- The dispatcher performs no persistence.
- The dispatcher performs no execution-state updates.
- This behavior is intentional for Phase 2I.

Closeout:

- Focused regression coverage completed for the dispatcher port, fake
  dispatcher, command-service dispatch orchestration, composition wiring, HTTP
  translation command, vertical integration, provider metadata preservation,
  domain-event composition, and Saved Transcript Retranslation composition.
- No production code changed during closeout.

Deferred:

- Real dispatcher implementation.
- Background execution.
- Queue, scheduler, or worker behavior.
- Provider resolution from the dispatcher.
- Provider execution from the dispatcher.
- Execution status updates from dispatch.
- `TranslationOutput` creation from dispatch.

### Phase 2K - Production Translation Runtime

Status: Completed.

Scope:

- Production Runtime Port.
- Production Runtime Adapter.
- Production Composition Wiring.
- Runtime Vertical Integration.
- Runtime Failure Lifecycle.

Runtime architecture:

- `ProductionTranslationExecutionProvider` is the application-layer execution
  provider port used by Translation Command runtime execution.
- The production runtime adapter resolves a provider through
  `TranslationProviderResolver` for each execution request.
- `providerKey` is forwarded to the resolver as provider-selection metadata.
- The resolved provider receives provider input only: `sourceText`,
  `sourceLanguageCode`, `targetLanguageCode`, `requestId`, `sessionId`, and
  `executionId`.
- `providerKey` is not passed into the resolved provider's `translate()` input.
- Production composition builds the resolver-backed runtime adapter unless a
  caller supplies an explicit `translationExecutionProvider`.
- Supplied fake/test execution providers remain supported for deterministic
  composition and focused tests.

Runtime flow:

```text
Execution Created
↓
Provider Execute
↓
Output Created
↓
Execution Completed
```

Runtime failure lifecycle:

```text
Execution Created
↓
Provider Execute
↓
throws
↓
Execution Failed
```

Failure behavior:

- Provider exceptions propagate unchanged.
- The persisted `TranslationExecution` is updated to `failed`.
- `TranslationOutput` is not created.
- `completed` execution state is not written after provider failure.
- Existing HTTP error responses remain unchanged and generic.

Closeout:

- Focused regression coverage completed for the production runtime port,
  production runtime adapter, production composition wiring, Translation
  Command service execution, and production runtime vertical integration.
- Documentation updated in README, ROADMAP, and CHANGELOG.
- No production runtime behavior changed during closeout.

Deferred:

- Retry.
- Timeout.
- Cancellation.
- Idempotency.
- Error Classification.
- Observability.
- Fallback.
- Background workers.
- Streaming.
- Multi-provider orchestration.
- HTTP API contract changes.
- Resolver contract changes.

### Phase 2L - Execution Reliability

Status: Completed.

Scope:

- RetryPolicy abstraction.
- TranslationExecutionRunner.
- Retry execution.
- Exhausted retry semantics.
- Production composition wiring.
- Production vertical integration.

Execution reliability architecture:

```text
HTTP
    |
    v
TranslationCommandController
    |
    v
TranslationCommandService
    |
    v
TranslationExecutionRunner
    |--------> RetryPolicy
    |
    v
TranslationExecutionProvider
```

Responsibilities:

- `TranslationCommandService` orchestrates command handling, domain object
  creation, repository persistence, and command-domain event publication.
- `TranslationExecutionRunner` owns provider execution, output creation,
  execution completion persistence, and execution failure persistence.
- `RetryPolicy` decides whether a failed provider attempt is eligible for
  another attempt.
- `TranslationExecutionProvider` performs translation execution through the
  configured runtime provider path.

Current production behavior:

- Production composition uses `RetryPolicy(maxRetries = 0)`.
- Provider execution occurs once.
- Provider failures are not retried.
- Successful execution immediately persists one `TranslationOutput` and marks
  the execution `completed` after `created`, `queued`, and `running` states are
  persisted.
- Failed execution immediately marks the execution `failed` after `created`,
  `queued`, and `running` states are persisted and the first provider failure
  occurs.
- `nextDelay()` is consulted for future compatibility only. No wait, sleep,
  timer, or backoff strategy is executed.

Success lifecycle:

```text
create execution
↓
mark queued
↓
mark running
↓
provider execute
↓
persist output
↓
mark completed
```

Failure lifecycle:

```text
create execution
↓
mark queued
↓
mark running
↓
provider execute
↓
mark failed
↓
rethrow provider error
```

Configured retry lifecycle:

```text
attempt
↓
failure
↓
RetryPolicy
↓
next attempt

...

retry exhausted
↓
mark failed
```

Failed execution persistence occurs only after retry exhaustion. With the
current production default, exhaustion happens after the first failed provider
attempt because `maxRetries = 0`.

Closeout:

- Focused regression coverage completed for `RetryPolicy`,
  `TranslationExecutionRunner`, production composition wiring, Translation
  Command service execution, and production HTTP vertical integration.
- Production vertical integration verifies provider resolution, provider input
  shape, explicit and omitted `providerKey` attribution, one output on success,
  completed lifecycle on success, failed lifecycle on provider failure, no
  fallback provider execution, and exactly one provider attempt on failure.
- Existing HTTP success and generic internal-error contracts remain unchanged.
- No runtime retry configuration, environment retry configuration, HTTP fields,
  status codes, repository schema changes, queue, worker, timers, logging, or
  metrics were added.

Future enhancement candidates:

- Exponential backoff.
- Sleep or timer-backed delays.
- Scheduling.
- Background workers.
- Queue execution.
- Retry metrics.
- Retry persistence or attempt history.
- Timeout handling.
- Cancellation.
- Environment-configurable retry policy.
- Idempotency.
- Error classification.
- Observability.

### Phase 2M - Runtime Provider Resolution

Status: Completed.

Scope:

- `TranslationExecutionProviderResolver` application boundary.
- Resolver-backed Translation Command runtime execution.
- Fake runtime execution provider resolver behavior.
- Production composition provider-key registration.
- Runtime provider resolution vertical integration.

Runtime provider-resolution architecture:

```text
HTTP
    |
    v
TranslationCommandController
    |
    v
TranslationCommandService
    |
    v
TranslationExecutionRunner
    |--------> RetryPolicy
    |
    v
resolver-backed execution provider
    |
    v
TranslationExecutionProviderResolver
    |
    v
TranslationExecutionProvider
    |
    v
repository persistence
```

Responsibilities:

- `TranslationCommandService` builds the runtime execution path from the
  injected `translationExecutionProviderResolver`.
- During `TranslationExecutionRunner` execution, the resolver-backed execution
  provider passes the execution `providerKey` to
  `translationExecutionProviderResolver.resolve(providerKey)`.
- `TranslationExecutionProviderResolver` owns runtime execution provider
  selection. It does not execute providers, persist records, orchestrate
  retries, create outputs, or manage lifecycle state.
- The resolved `TranslationExecutionProvider` receives the existing execution
  provider input shape: `sourceText`, `sourceLanguageCode`,
  `targetLanguageCode`, and `providerKey`.
- `TranslationExecutionRunner` continues to own retry checks, provider
  invocation through the resolved provider, `TranslationOutput` persistence,
  completed-state persistence, failed-state persistence, and original exception
  propagation.

Runtime success flow:

```text
create execution
↓
mark queued
↓
mark running
↓
resolve execution provider
↓
provider execute
↓
persist output
↓
mark completed
```

Runtime provider-resolution failure flow:

```text
create execution
↓
mark queued
↓
mark running
↓
resolve execution provider
↓
throws
↓
mark failed
↓
rethrow resolver error
```

Current provider behavior:

- Explicit `providerKey` is used for runtime execution provider resolution.
- Omitted `providerKey` resolves to the resolver's configured default provider.
- The fake resolver default provider key is `fake`.
- Production composition registers the current production runtime execution
  provider wrapper under `gemini`, preserving existing omitted-provider and
  explicit Gemini behavior.
- Current supported runtime execution provider keys are `fake` for supplied
  fake/test execution providers and `gemini` for the current production runtime
  execution provider wrapper.
- Unknown runtime execution provider keys throw
  `translation execution provider not found: <providerKey>`.
- Unknown-provider resolution failures persist `created`, `queued`, `running`,
  and `failed` execution states, create no `TranslationOutput`, write no
  completed execution state, and rethrow the original resolver exception.
  Existing generic HTTP 500 behavior remains unchanged.

Closeout:

- Focused regression coverage completed for the fake resolver, Translation
  Command service execution, production composition wiring, and production HTTP
  vertical integration.
- The successful execution lifecycle and existing API contract remain
  unchanged.
- No production provider implementation, retry policy, HTTP API, persistence
  schema, frontend behavior, fallback behavior, provider health check, or
  provider-selection UI was added.

Current limitations:

- Runtime provider selection is limited to the existing fake execution provider
  shape and production Gemini runtime wrapper.
- No real OpenAI, Azure, or additional Gemini execution provider was added.
- No fallback provider selection.
- No provider health checks.
- No frontend provider controls.
- No runtime provider metrics or observability.
- No retry policy changes.

### Phase 2N - Gemini Translation Execution Provider

Status: Completed.

Scope:

- Production `GeminiTranslationExecutionProvider`.
- `GeminiClient` HTTP request construction, response parsing, and provider
  result normalization.
- Production composition wiring for `GEMINI_API_KEY` and `GEMINI_MODEL`.
- Runtime `gemini` provider registration through
  `TranslationExecutionProviderResolver`.
- Fake HTTP vertical integration coverage for the Gemini runtime execution
  path.
- Gemini HTTP failure mapping.

Runtime architecture:

```text
TranslationExecutionRunner
    |
    v
TranslationExecutionProviderResolver
    |
    v
GeminiTranslationExecutionProvider
    |
    v
GeminiClient
    |
    v
Gemini HTTP client
```

Current provider behavior:

- `providerKey: "gemini"` resolves to the production Gemini execution provider.
- Omitted provider keys use the configured default provider key. When
  `TRANSLATION_PROVIDER` is unset, the default remains `gemini`.
- The production Gemini execution provider delegates to `GeminiClient` and
  returns the existing provider result format.
- `GeminiClient` maps 400, 401, 403, 429, 5xx, and generic HTTP failures to a
  stable `GeminiHttpError` while preserving existing exception propagation
  through the runner and application boundary.
- Invalid Gemini responses remain explicit invalid-response errors.

Closeout:

- Unit coverage verifies request construction, response parsing, failure
  mapping, input immutability, provider delegation, and no real API calls.
- Production vertical integration uses a fake HTTP client to verify provider
  dispatch, `TranslationOutput` persistence, completed execution lifecycle,
  failed execution lifecycle, and no real Gemini API call.
- Fake provider and fake resolver coverage remains unchanged and passing.
- README, ROADMAP, and CHANGELOG document Phase 2N completion.

Deferred:

- Real Gemini API validation. It still requires configured `GEMINI_API_KEY` and
  `GEMINI_MODEL`.
- Streaming.
- Retry policy changes.
- Timeout handling.
- Metrics or logging changes.
- Provider fallback.
- Multiple production runtime providers.

### Phase 2O - Production Gemini Translation Execution

Status: Completed.

Scope:

- `GeminiTranslationExecutionProvider` as the production
  `TranslationExecutionProvider` adapter.
- Production composition creates `GeminiClient`, creates
  `GeminiTranslationExecutionProvider`, registers it under `gemini`, and uses
  `gemini` as the default provider when `TRANSLATION_PROVIDER` is unset.
- Test and supplied-provider composition keeps `FakeTranslationExecutionProvider`
  behavior unchanged.
- Unit, composition, vertical integration, and error integration coverage for
  the Gemini translation execution path.

Production execution architecture:

```text
TranslationCommandService
    |
    v
TranslationExecutionProviderResolver
    |
    v
GeminiTranslationExecutionProvider
    |
    v
GeminiClient
    |
    v
Gemini API
```

Current behavior:

- `providerKey: "gemini"` resolves to the production Gemini execution provider.
- Omitted provider keys use the configured default provider key. When
  `TRANSLATION_PROVIDER` is unset, the default remains `gemini`.
- `GeminiTranslationExecutionProvider` performs adapter-level request/response
  mapping only. It does not own orchestration, persistence, retry, timeout,
  logging, metrics, or fallback behavior.
- Successful execution uses the current lifecycle:
  `Execution Created` -> `Execution Queued` -> `Execution Running` ->
  `Gemini Provider Execute` -> `TranslationOutput Created` ->
  `Execution Completed`.
- Provider failure uses the current lifecycle:
  `Execution Created` -> `Execution Queued` -> `Execution Running` ->
  `Gemini Provider Execute` throws -> `Execution Failed`. No
  `TranslationOutput` is created, and the original provider error is rethrown
  through the application boundary.

Closeout:

- Unit tests cover `GeminiTranslationExecutionProvider` request mapping,
  response mapping, direct error propagation, and legacy client compatibility.
- Composition tests verify Gemini provider wiring, default `gemini` behavior,
  supplied fake provider isolation, and deterministic unknown-provider failure.
- Vertical integration verifies `POST /api/translation-executions` can execute
  through `TranslationCommandService`,
  `TranslationExecutionProviderResolver`,
  `GeminiTranslationExecutionProvider`, and a fake `GeminiClient` to persist one
  `TranslationOutput` and complete the execution.
- Error integration verifies `GeminiHttpError` from a fake `GeminiClient` keeps
  the existing failed-execution lifecycle, creates no output, and is rethrown
  unchanged at the application boundary.

Deferred:

- Real Gemini API validation. It still requires configured `GEMINI_API_KEY` and
  `GEMINI_MODEL`.
- Streaming or live translation execution through this command path.
- Retry policy changes.
- Timeout handling.
- Metrics or logging changes.
- Provider fallback.
- Multiple production runtime providers.

### Phase 2P - Translation Execution Lifecycle

Status: Completed.

Scope:

- Extend the `TranslationExecution` domain lifecycle with `created`, `queued`,
  `running`, `completed`, and `failed`.
- Persist successful Translation Command execution states in order:
  `created -> queued -> running -> completed`.
- Persist provider-failure execution states in order:
  `created -> queued -> running -> failed`.
- Preserve existing provider invocation count, provider input/output contracts,
  `TranslationOutput` persistence behavior, HTTP API contract, and original
  provider-error propagation.

Current behavior:

- `TranslationExecution` defaults to `created`.
- `TranslationCommandService` persists `queued` after creation and `running`
  before invoking the configured execution provider.
- Successful provider execution persists one `TranslationOutput` before the
  execution is marked `completed`.
- Provider failure creates no `TranslationOutput`, persists the execution as
  `failed`, and rethrows the original provider exception unchanged.
- `queued` is a domain lifecycle state only. Phase 2P does not introduce a queue
  runtime, scheduler, worker, retry behavior, timeout handling, cancellation,
  metrics, provider behavior, HTTP contract changes, or persistence-format
  changes.

Success lifecycle:

```text
created
↓
queued
↓
running
↓
completed
```

Failure lifecycle:

```text
created
↓
queued
↓
running
↓
failed
```

Closeout:

- Domain tests verify supported statuses, explicit `queue()` and `start()`
  transitions, completed and failed terminal behavior, and deterministic
  rejection of unsupported legacy statuses.
- Application service tests verify persisted lifecycle order, provider execution
  after `running`, output before `completed`, no output on provider failure, and
  original provider error identity.
- Production vertical integration verifies the same success and failure
  lifecycle order through production composition.

Deferred:

- Queue runtime.
- Scheduler or worker execution.
- Timeout handling.
- Cancellation.
- Metrics or logging changes.
- Provider behavior changes.
- HTTP contract changes.
- Persistence-format changes.

### Phase 3A - Async Execution Runtime

Status: Completed.

Scope:

- Add a minimal Translation Execution Queue contract.
- Add deterministic in-memory FIFO queue behavior.
- Change Translation Command submission to persist `created`, persist `queued`,
  enqueue an identifier-only job, and return a queued execution.
- Add `TranslationExecutionWorker` to dequeue one job, load persisted
  execution/request objects, and delegate execution to
  `TranslationExecutionRunner`.
- Add repository lookup support for `findExecutionById(executionId)` and
  `findRequestById(requestId)`.
- Wire production composition so `TranslationCommandService` and
  `TranslationExecutionWorker` share the same queue and repository.
- Update `POST /api/translation-executions` to return `202 Accepted` for
  asynchronous submission.
- Add success and failure vertical integration coverage for HTTP submission,
  queueing, worker processing, provider execution, output persistence, and
  final lifecycle states.
- Add `TranslationExecutionWorkerRuntime` as a start/stop polling adapter around
  `TranslationExecutionWorker.processNext()`.

Current async submission flow:

```text
POST /api/translation-executions
↓
persist created
↓
persist queued
↓
enqueue job
↓
202 Accepted
```

Current worker processing flow:

```text
TranslationExecutionWorkerRuntime
↓
TranslationExecutionWorker
↓
TranslationExecutionRunner
↓
TranslationExecutionProvider
↓
completed / failed
```

Success lifecycle:

```text
created
↓
queued
↓
running
↓
completed
```

Failure lifecycle:

```text
created
↓
queued
↓
running
↓
failed
```

Completed work:

- Execution Queue.
- Async Submission.
- TranslationExecutionWorker.
- Repository Lookup.
- Production Composition.
- HTTP Contract.
- Success Vertical Integration.
- Failure Vertical Integration.
- Worker Runtime.

Current limitations:

- In-memory queue only.
- Worker Runtime is not automatically started by production startup.
- Durable queue is not supported.
- Cancellation is not supported.
- Timeout handling is not supported.
- Multi-worker processing is not supported.
- Queue retry and dead-letter queue behavior are not supported.
- Metrics are not supported.

### Phase 3B - Queue Abstraction

Status: Completed.

Completed:

- `ExecutionQueue` application contract for `enqueue(item)`, `dequeue()`, and
  `size()`.
- In-memory FIFO queue implements the shared contract.
- Worker, command service, and composition validation depend on the queue
  abstraction instead of partial one-off method checks.
- Production composition still creates the in-memory queue by default.
- `TranslationExecutionWorkerRuntime` exposes `start()`, `stop()`, and
  `isRunning()`.
- Worker Runtime start/stop/restart behavior is repeatable and prevents
  duplicate polling loops.
- Production composition creates and exposes the Worker Runtime without
  automatically starting it.
- Worker Runtime checks the shared queue before invoking the Worker, waits on
  empty queues through scheduled polling, resumes after new enqueue activity,
  and can process multiple queued jobs across the same running loop.
- Worker Runtime stop requests prevent new queue work while allowing the
  in-flight Worker execution to finish before the runtime reports stopped.
- Restart after graceful stop resumes processing remaining queued work.
- Production vertical integration verifies `POST -> Queue -> Worker ->
  completed`, unstarted Runtime queued state, Runtime start of existing queue
  work, Runtime stop preserving newly queued work, and Runtime restart
  processing remaining FIFO work.
- Documentation closeout updated README, roadmap, architecture overview, and
  changelog with current Queue abstraction, Worker Runtime lifecycle, Worker
  Loop, graceful shutdown, runtime integration status, and implementation
  limitations.

Deferred:

- Redis, RabbitMQ, or other external queue infrastructure.
- Retry, timeout, cancellation, priority, or parallel worker behavior.

### Phase 3C - Durable Queue Foundation

Status: Completed.

Completed:

- WP1 Queue Port.
- WP2 Repository Contract.
- WP3 File Repository.
- WP4 Feature-gated Composition.
- WP5 Dual-write Enqueue.
- WP6 Startup Recovery.
- WP7 Documentation.

Implemented behavior:

- Durable Queue is feature-gated by `TRANSLATION_DURABLE_QUEUE_ENABLED`.
- The default path remains disabled and uses the active in-memory queue only.
- When enabled, production composition creates
  `FileDurableTranslationExecutionQueueRepository`.
- When enabled, production composition wraps the active in-memory queue with
  `DualWriteTranslationExecutionQueue`.
- Dual-write enqueue persists a durable queue item before enqueueing the active
  in-memory queue.
- When enabled, Worker Runtime startup runs
  `StartupTranslationExecutionQueueRecovery` before polling begins.
- Startup recovery replays durable items with
  `peek -> active enqueue -> durable dequeue`.
- HTTP API behavior, execution lifecycle, Worker processing, and provider
  execution behavior are unchanged.

Current limitations:

- Replay removes each item from the durable repository immediately after it is
  enqueued into the active in-memory queue.
- No acknowledgement.
- No completion-driven removal.
- No replay deduplication.
- No lease.
- No visibility timeout.
- No retry.
- No dead-letter queue.
- No multi-worker support.
- No locking or concurrency control.

### Phase 3D - Reliable Durable Queue

Status: Planned.

Candidate scope:

- Acknowledgement.
- Completion-driven removal.
- Replay reconciliation.
- Duplicate prevention.
- Lease.
- Visibility timeout.
- Retry.
- Dead-letter queue.
- Multi-worker safety.
- Locking or concurrency control.

### Phase 2 Deferred Scope

Deferred:

- Settings, unless separately selected.
- Usage Metrics.
- Diagnostics.
- Transcript Search.
- Storage, unless justified later.
- Durable database.
- Event outbox.
- Broker.
- Event replay.
- Raw audio storage.
- Text-to-speech regeneration.
- Billing.
- Multi-tenancy.
- Production deployment concerns.
- Audio output selection.
- AudioWorklet migration.

## 5. Phase 3 - Production

Status: Future

### Candidate Features

- OAuth / SSO
- RBAC
- User management
- Team / organization support
- Monitoring
- Metrics
- Alerting
- Audit logs
- CI/CD
- Docker
- Production deployment guides
- Multi-user sessions
- Meeting translation mode
- Speaker diarization
- AI summary
- Transcript export / archive

## 6. Agent Guidance

- Always check ROADMAP.md before proposing new features.
- Do not implement Phase 2 or Phase 3 features unless explicitly requested.
- Keep Phase 1 stable.
- Prefer small scoped changes.
- When adding a feature, update ROADMAP.md status if relevant.
- If a request conflicts with current phase scope, ask for confirmation before implementation.

## 7. Definition of Done by Phase

### Phase 1 Demo DoD

- Core real-time speech translation flow works in a local or controlled demo environment.
- Users can select a target language.
- Input and output transcripts are visible during a session.
- Translated audio playback works.
- Users can start and stop a session.
- Basic error handling is present.
- Security hardening has been applied for the demo scope.
- Testing documentation exists.
- P0 hardening tests have passed.

### Phase 2 Internal Tool DoD

- Access is restricted with basic login or access control.
- Translation history or session history is available if selected for implementation.
- Transcript export is available if selected for implementation.
- Audio device selection is available if selected for implementation.
- Session reliability is improved through reconnect, token refresh, or equivalent safeguards.
- Usage logging and admin review are available if selected for implementation.
- Internal users can use the tool repeatedly with predictable behavior.

### Phase 3 Production DoD

- Production-grade authentication and authorization are implemented.
- User, team, or organization management is available if required.
- Monitoring, metrics, alerting, and audit logging are available.
- CI/CD and deployment guidance are in place.
- Production deployment is documented and repeatable.
- Multi-user, meeting translation, speaker diarization, AI summary, or archive features are implemented only if explicitly selected for production scope.
- Operational risks are documented and reviewed before launch.

## 8. Open Questions

- Is login required?
- Should translation records be saved?
- Should multi-person meeting support be added?
- Is formal deployment required?
- Which subtitle export formats are required?
