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

Current milestone: Phase 2L Execution Reliability.

Phase 1 Demo is completed. Phase 2A Foundation is completed. Phase 2 overall is
in progress and not completed. Phase 2C Saved Transcript Re-translation,
Phase 2D Production Gemini Saved-Transcript Translation, and Phase 2E
Translation Provider Architecture are completed. Phase 2F Translation Provider
Configuration is completed. Phase 2G Request-Scoped Provider Selection is
completed. Phase 2H Translation Command Provider Attribution is completed.
Phase 2I Translation Execution Dispatcher is completed. Phase 2K Production
Translation Runtime is completed.

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
- Phase 2L - Execution Reliability: Planned
  - Retry
  - Timeout
  - Cancellation
  - Idempotency
  - Error Classification
  - Observability
- Phase 2 overall: In Progress, Phase 2L Execution Reliability current

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

Status: Planned.

Scope:

- Retry.
- Timeout.
- Cancellation.
- Idempotency.
- Error Classification.
- Observability.

Phase 2L must build on the Phase 2K runtime lifecycle without changing the
existing provider resolver contract or broadening runtime behavior unless that
work package explicitly requires it.

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
