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
- Phase 2I - Translation Execution Dispatcher
- Phase 2K - Production Translation Runtime
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

Phase 2I
Status: Completed

Phase 2I status:

- `TranslationExecutionDispatcher` is the application-layer execution
  orchestration port for `TranslationExecution` creation.
- Dispatch is asynchronous and is invoked immediately after
  `TranslationExecution` repository persistence.
- `TranslationCommandService` awaits dispatch completion before the request
  completes. The dispatcher receives the original persisted
  `TranslationExecution` instance, its return value is ignored, and dispatcher
  errors propagate unchanged through the command path.
- Current production composition injects `FakeTranslationExecutionDispatcher`.
  The fake dispatcher records dispatches only; it does not execute providers,
  create a queue, schedule work, run a worker, or perform background execution.
- Current create-execution ordering is:
  `create TranslationExecution` -> repository persistence ->
  `TranslationExecutionDispatcher.dispatch()` -> existing domain-event
  publication -> request completes.
- Dispatch occurs after persistence, is awaited, does not change execution
  state, does not create `TranslationOutput`, and does not resolve providers.
- `providerKey` remains metadata only. Explicit keys are preserved, omitted
  keys remain `undefined`, and the dispatcher does not resolve providers.
  Saved Transcript Retranslation remains the only request-scoped
  provider-resolution flow.
- The dispatcher currently performs no execution, translation, retries,
  scheduling, queueing, persistence, or execution-state updates. This is
  intentional for Phase 2I.

Phase 2K
Status: Completed

Phase 2K status:

- Translation Command production composition now creates a Production
  Translation Runtime for `POST /api/translation-executions`.
- `ProductionTranslationExecutionProvider` is the application-layer runtime
  provider port. It delegates `execute(input)` to an injected implementation,
  returns the implementation result unchanged, and propagates implementation
  errors unchanged.
- The production runtime adapter resolves a translation provider through
  `TranslationProviderResolver` for each execution request. It forwards
  `providerKey` to the resolver, then calls the resolved provider's
  `translate()` method with provider input only: `sourceText`,
  `sourceLanguageCode`, `targetLanguageCode`, `requestId`, `sessionId`, and
  `executionId`. It does not pass `providerKey` into provider translation
  input.
- `TranslationProviderResolver` owns provider selection. Explicit
  `providerKey` values override the configured default provider for the
  request; omitted keys use `TRANSLATION_PROVIDER`, defaulting to `gemini` when
  unset. Unknown provider keys still propagate the existing registry error.
  There is no fallback behavior.
- Translation Command runtime success flow is:
  `Execution Created` -> `Provider Execute` -> `Output Created` ->
  `Execution Completed`.
- Runtime failure lifecycle is:
  `Execution Created` -> `Provider Execute` throws -> `Execution Failed`.
  Provider errors skip `TranslationOutput` creation, avoid completed-state
  writes, persist the execution as `failed`, and propagate the original
  exception.
- Fake runtime and production runtime remain separate. Fake/test composition
  can still inject a supplied fake execution provider for deterministic
  coverage. Production composition builds the resolver-backed runtime adapter
  unless an explicit execution provider is supplied by the caller.
- Phase 2K does not add retry, timeout, cancellation, idempotency, error
  classification, logging, metrics, background workers, streaming,
  multi-provider fallback, HTTP API changes, resolver contract changes, or
  frontend provider controls.

Documentation:

- [docs/architecture/architecture-overview.md](docs/architecture/architecture-overview.md) - High-level system architecture, runtime flow, module responsibilities, dependency boundaries, completed capabilities, and deferred architecture.
- [docs/architecture/domain-model.md](docs/architecture/domain-model.md) - Core domain objects, ownership, lifecycle, relationships, and future extension boundaries.

Planned next capability:

- Phase 2L - Execution Reliability
  - Retry
  - Timeout
  - Cancellation
  - Idempotency
  - Error Classification
  - Observability
