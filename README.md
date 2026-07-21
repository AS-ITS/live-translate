# Live Translate

Live Translate is a session-oriented real-time multilingual translation platform
that accepts Chinese or mixed-language speech, generates a selected target-language
output, and preserves reusable session transcripts for future translations into
additional languages. The backend owns `GEMINI_API_KEY` and issues short-lived
ephemeral tokens so the browser can connect directly to the Gemini Live API.

## Current Status

Phase 2A Foundation
Status: Completed

## Durable Queue Reliability

When `TRANSLATION_DURABLE_QUEUE_ENABLED=true`, execution work follows:

```text
Queue → claim → heartbeat renewal → fenced Runner persistence → token-aware acknowledgement
```

`TRANSLATION_QUEUE_LEASE_MS` controls the processing lease duration and
`TRANSLATION_QUEUE_LEASE_RENEWAL_MS` controls the heartbeat interval. A
successfully renewed item remains active and startup recovery does not replay
it. Reclaiming an expired lease creates a higher `fenceToken`; stale workers are
rejected before output, terminal-state, or acknowledgement persistence. The
production integration suite uses fake providers, clocks, and schedulers only.

Each execution has a stable `providerIdempotencyKey`. It is provider metadata
only: it is never included in the translation prompt, output, or HTTP response.
Provider attempts persist `not_started → in_flight → succeeded | failed`.
Successful attempts persist a result snapshot before output and execution
completion, so recovery can reconcile output without another provider call.

Provider capability controls expired `in_flight` recovery: `guaranteed` may
replay with the same key; `unknown` and `unsupported` keep the durable item for
safe manual or future handling. Gemini currently declares `unknown`: accepting
`metadata.idempotencyKey` is not a verified remote deduplication guarantee.

Current limitations: no cross-storage transaction, distributed locking,
cross-process atomicity, event-publishing deduplication, or metrics/alerting.
Retry/backoff and terminal dead-letter transfer are durable; DLQ replay and
retention policies remain out of scope.

Phase 2 Overall
Status: In Progress

## Phase 4A Closeout

Phase 4A is complete and ready for controlled manual testing. A saved session
can submit multiple asynchronous translations, then read its session-scoped,
read-only Translation history at `GET /api/sessions/:sessionId/translations`.
The detail UI shows each request, execution status, output, and available source
language detection, and filters the displayed records by target language.

- Supported target languages: `en`, `ja`, `ko`, `zh-Hant`, `zh-Hans`, `es`,
  `fr`, and `de` (`zh-Hant` is the live-token default).
- `sourceLanguageDetection` is canonical optional transcript metadata. It can
  represent mixed languages, but Gemini does not currently guarantee reliable
  segment-level detection.
- A glossary is provider instruction only. It never rewrites stored source
  transcript text or a `TranslationOutput`.
- History reads do not start providers, queues, workers, runners, or glossary
  loading and do not mutate records.

## Phase 4B Closeout

A completed Session can submit a new re-translation from its persisted canonical
source transcript. The user selects an allowlisted target language; each accepted
submission creates a distinct request and queued execution. Completed formal
outputs are versioned independently for each `(sessionId, targetLanguageCode)`,
so the same language can have, for example, English v1 and English v2 while a
different language starts at v1.

Session detail keeps completed formal outputs separate from pending or
failed-only executions. Users can switch among formal output versions and
languages. TXT, SRT, and VTT export uses the currently selected formal output;
pending or failed-only history has no formal-output export. A legacy-only
Session remains a read-only compatibility fallback and continues to use its
existing saved-session exporter.

History refreshes while an execution is pending. It is polling, not a
real-time completion guarantee. The UI does not provide manual retry, cancel,
DLQ management, or cross-Session history search.

### Production and Manual Gemini Smoke Test

Configure secrets outside version control. `GEMINI_API_KEY` is required by the
backend and must never be supplied to the browser. Production translation also
requires `GEMINI_MODEL`; `TRANSLATION_PROVIDER=gemini` is the supported provider
selection (and is the default when omitted).

For durable asynchronous work, set `TRANSLATION_DURABLE_QUEUE_ENABLED=true` and
provide writable `TRANSLATION_DURABLE_QUEUE_FILE` and
`TRANSLATION_DEAD_LETTER_QUEUE_FILE` paths. Keep these files outside the source
tree and back them up according to the deployment's retention policy.

`TRANSLATION_GLOSSARY_FILE` is optional. It points to a JSON file such as:

```json
{
  "entries": [
    { "source": "OpenAI", "targets": { "ja": "OpenAI" } }
  ]
}
```

If it is unset or its configured file does not exist, no glossary instruction
is added. Invalid JSON or entries fail clearly rather than silently altering
text.

Start the backend with `npm run start:production` and the frontend with
`npm run dev`. For a manual smoke test: configure the server-only environment,
start a session, choose a supported language, speak mixed-language audio, stop
the session, submit translations, wait for worker completion, then open the
same session detail and filter Translation history. Real Gemini testing is
manual and opt-in only; automated tests use fakes and mocks.

Current limitations: no account or authorization model, no glossary management
UI/API, no cross-session history, and Gemini translation/detection quality must
be confirmed in the target environment.

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
- Phase 2L - Execution Reliability
- Phase 2M - Runtime Provider Resolution
- Phase 2N - Gemini Translation Execution Provider
- Phase 2O - Production Gemini Translation Execution
- Phase 2P - Translation Execution Lifecycle
- Phase 3A - Async Execution Runtime
- Phase 3B - Queue Abstraction and Worker Runtime Lifecycle
- Phase 3C - Durable Queue Foundation
- Phase 3E - Durable Queue Deduplication & Idempotent Recovery
- Phase 3F - Durable Queue Terminal Acknowledgement & Recovery Eligibility
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
  `Execution Created` -> `Execution Queued` -> `Execution Running` ->
  `Provider Execute` -> `Output Created` -> `Execution Completed`.
- Runtime failure lifecycle is:
  `Execution Created` -> `Execution Queued` -> `Execution Running` ->
  `Provider Execute` throws -> `Execution Failed`.
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

Phase 2L
Status: Completed

Phase 2L status:

- Translation Command execution now follows this production pipeline:

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

- `TranslationCommandService` orchestrates command handling, domain creation,
  repository persistence, and command-domain event publication.
- `TranslationExecutionRunner` owns provider execution, `TranslationOutput`
  creation, completion persistence, and failure persistence for execution
  commands.
- `RetryPolicy` determines whether a failed provider attempt is eligible for
  another attempt.
- `TranslationExecutionProvider` performs translation execution through the
  configured runtime provider path.
- Production composition uses `RetryPolicy(maxRetries = 0)`. Provider execution
  occurs once, provider failures are not retried, successful execution
  immediately completes, and exhausted execution immediately fails.
- `nextDelay()` is consulted only for future compatibility. The current runner
  does not wait, sleep, schedule timers, or execute a backoff strategy.

Successful execution lifecycle:

```text
create execution
        |
        v
mark queued
        |
        v
mark running
        |
        v
provider execute
        |
        v
persist output
        |
        v
mark completed
```

Failure lifecycle:

```text
create execution
        |
        v
mark queued
        |
        v
mark running
        |
        v
provider execute
        |
        v
mark failed
        |
        v
rethrow provider error
```

Configured retry lifecycle:

```text
attempt
    |
    v
failure
    |
    v
RetryPolicy
    |
    v
next attempt

...

retry exhausted
        |
        v
mark failed
```

Failed execution persistence occurs only after retry exhaustion. With the
current production default, exhaustion happens after the first failed provider
attempt because `maxRetries = 0`.

Current Phase 2L limitations:

- No exponential backoff.
- No sleep or timers.
- No scheduling, background worker, or queue execution.
- No retry metrics.
- No retry persistence or attempt history.
- No timeout handling.
- No cancellation.
- No environment-configurable retry policy.

Phase 2M
Status: Completed

Phase 2M status:

- `TranslationExecutionProviderResolver` is the application-layer runtime
  provider-resolution boundary for Translation Command execution.
- `TranslationCommandService` now builds the runtime path from a
  `translationExecutionProviderResolver`; during runner execution, the
  resolver-backed execution provider calls `resolve(providerKey)` before
  invoking the resolved provider.
- `TranslationExecutionRunner` still owns retry checks, `TranslationOutput`
  creation, completed-state persistence, failed-state persistence, and original
  exception propagation.
- Runtime execution flow is:

```text
create execution
        |
        v
mark queued
        |
        v
mark running
        |
        v
TranslationExecutionRunner
        |
        v
resolve execution provider
        |
        v
provider execute
        |
        v
persist output
        |
        v
mark completed
```

- Provider-resolution failure uses the existing provider-failure lifecycle:

```text
create execution
        |
        v
mark queued
        |
        v
mark running
        |
        v
TranslationExecutionRunner
        |
        v
resolve execution provider
        |
        v
mark failed
        |
        v
rethrow resolver error
```

- When `providerKey` is omitted, the resolver uses its configured default
  provider key.
- The fake resolver default provider key is `fake`. Production composition
  registers the production runtime execution provider under `gemini` so current
  omitted-provider and explicit Gemini production behavior is preserved.
- Current supported runtime execution provider keys are:
  - `fake` for supplied fake/test execution providers.
  - `gemini` for the current production runtime execution provider wrapper.
- Unknown runtime execution provider keys throw a deterministic
  `translation execution provider not found: <providerKey>` error. The created
  execution is persisted as `failed`, no `TranslationOutput` is created, no
  completed-state write occurs, and the original resolver exception is
  rethrown at the application boundary.
- Current runtime provider selection remains limited to the existing fake
  execution provider shape and production Gemini runtime wrapper. Phase 2M does
  not add real OpenAI, Azure, additional Gemini provider implementations,
  fallback, provider health checks, provider-selection UI, HTTP API changes, or
  retry policy changes.

Phase 2N
Status: Completed

Phase 2N status:

- Production Translation Command execution now has a concrete
  `GeminiTranslationExecutionProvider` backed by `GeminiClient`.
- Production composition wires `GEMINI_API_KEY` and `GEMINI_MODEL` into the
  Gemini execution path:

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

- `providerKey: "gemini"` resolves to the Gemini execution provider. Omitted
  provider keys still use the configured default provider key, defaulting to
  `gemini`.
- `GeminiClient` builds deterministic Gemini `generateContent` HTTP requests,
  normalizes Gemini-style responses into the existing provider result format,
  and maps Gemini HTTP failures for 400, 401, 403, 429, 5xx, and generic HTTP
  failures while preserving the existing exception propagation lifecycle.
- Production vertical integration is verified with a fake HTTP client, proving
  `TranslationOutput` creation, `TranslationExecution` completion, failed
  execution persistence, and no real Gemini API call during automated tests.
- Fake execution provider injection and fake resolver tests remain supported
  for deterministic test composition.
- Real Gemini API validation still requires a configured `GEMINI_API_KEY` and
  `GEMINI_MODEL` and remains outside automated test execution.

Current Phase 2N limitations:

- No streaming translation execution.
- No retry policy changes.
- No timeout handling.
- No metrics or logging changes.
- No provider fallback or multi-provider runtime behavior.

Phase 2O
Status: Completed

Production Translation Execution Architecture:

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

Phase 2O status:

- Production Translation Command execution defaults to the `gemini` provider
  through `TranslationExecutionProviderResolver`.
- Production composition creates `GeminiClient`, wraps it with
  `GeminiTranslationExecutionProvider`, and registers the provider under
  `gemini`.
- Test and supplied-provider composition continues to use
  `FakeTranslationExecutionProvider` for deterministic execution without
  calling Gemini.
- `GeminiTranslationExecutionProvider` is only an infrastructure adapter. It
  maps Translation Execution provider input to `GeminiClient`, calls the client,
  and maps the client response back to `translatedText` and
  `detectedSourceLanguageCode`.
- Translation execution success persists `created`, `queued`, `running`, and
  `completed` execution states in order. The provider is invoked only after
  `running` is persisted, and one `TranslationOutput` is persisted before the
  `completed` state.
- Translation execution failure persists `created`, `queued`, `running`, and
  `failed` execution states in order. Provider failure creates no output and
  rethrows the original provider error through the application boundary.

Current Phase 2O limitations:

- No streaming translation execution.
- No retry policy changes.
- No timeout handling.
- No metrics or logging changes.
- No provider fallback or multi-provider runtime behavior.
- No real Gemini API validation in automated tests.

Phase 2P
Status: Completed

Phase 2P status:

- `TranslationExecution` supports the explicit statuses `created`, `queued`,
  `running`, `completed`, and `failed`.
- Successful Translation Command execution persists this lifecycle:

```text
created
  |
  v
queued
  |
  v
running
  |
  v
completed
```

- Provider failure persists this lifecycle:

```text
created
  |
  v
queued
  |
  v
running
  |
  v
failed
```

- `queued` and `running` are domain states only. Phase 2P does not add a queue
  runtime, scheduler, worker, timeout, cancellation, metrics, provider behavior,
  HTTP contract changes, or persistence-format changes.
- Existing provider behavior is preserved: provider execution happens once by
  default, provider input/output contracts remain unchanged, success creates one
  `TranslationOutput`, failure creates no output, and original provider errors
  propagate unchanged at the application boundary.
- Focused domain, application service, and production vertical integration
  coverage verifies lifecycle order for success and failure.

Phase 3A
Status: Completed

Phase 3A status:

- HTTP submission and execution processing are now separated for
  `POST /api/translation-executions`.
- The HTTP request path validates input, creates and persists the execution,
  marks it `queued`, enqueues an identifier-only job, and returns `202
  Accepted` without waiting for provider execution.
- The queue job contains only:

```json
{
  "executionId": "execution-123",
  "requestId": "request-123"
}
```

- `TranslationOutput` is created only by Worker processing after provider
  execution succeeds. The HTTP submission response does not include output.
- The first queue adapter is deterministic in-memory FIFO. It is not durable
  and is not shared across processes.
- The Worker Runtime is a polling adapter around
  `TranslationExecutionWorker.processNext()`. It supports `start()`, `stop()`,
  and `isRunning()`, avoids reentrant worker execution, and continues polling
  after a worker error.
- Runtime construction exists, but production startup does not automatically
  start the Worker Runtime.

Phase 3B
Status: Completed

Phase 3B status:

- `TranslationExecutionQueue` is the application queue abstraction used by
  command submission, Worker, Worker Runtime, and production composition.
- The queue contract is `enqueue(item)`, `dequeue()`, and `size()`.
- The production queue adapter remains deterministic in-memory FIFO. It is not
  durable and is not shared across processes.
- Production composition creates and exposes the shared Queue, Worker, and
  Worker Runtime. It does not automatically start the Runtime.
- Worker Runtime lifecycle:
  - `start()` begins the polling loop when stopped.
  - Repeated `start()` calls do not create additional loops.
  - `stop()` prevents future polling and new queue work.
  - `isRunning()` reports true while the loop is active or a current worker
    execution is still finishing.
  - Restart after stop resumes processing remaining queued work.
- Worker Loop behavior:
  - The Runtime checks `queue.size()` before invoking the Worker.
  - Empty queues wait for the next scheduled poll without executing idle worker
    work.
  - Newly enqueued work is picked up on a later poll without restarting the
    Runtime.
  - A running Runtime processes queued executions one at a time in FIFO order.
- Graceful shutdown behavior:
  - `stop()` does not cancel or interrupt an in-flight
    `TranslationExecutionWorker.processNext()` call.
  - The current execution can finish and persist its normal lifecycle state.
  - After that current work finishes, the Runtime stops and does not process
    additional queued work until restarted.
- Production integration coverage verifies `POST -> Queue -> Worker ->
  completed`, queued state while the Runtime is not started, Runtime start
  completing existing queued work, Runtime stop preserving newly queued work,
  and Runtime restart processing remaining FIFO work.

HTTP async submission flow:

```text
POST /api/translation-executions
        |
        v
persist created
        |
        v
persist queued
        |
        v
enqueue job
        |
        v
202 Accepted
```

Worker execution flow:

```text
TranslationExecutionQueue
        |
        v
Worker Runtime
        |
        v
TranslationExecutionWorker
        |
        v
TranslationExecutionRunner
        |
        v
Provider
        |
        v
completed / failed
```

Async execution success lifecycle:

```text
created
  |
  v
queued
  |
  v
running
  |
  v
completed
```

Async execution failure lifecycle:

```text
created
  |
  v
queued
  |
  v
running
  |
  v
failed
```

Current Phase 3B limitations:

- In-memory queue only.
- Worker Runtime is not automatically started by production startup.
- No durable queue.
- No external queue such as Redis or RabbitMQ.
- No cancellation.
- No timeout handling.
- No multi-worker coordination.
- No queue retry or dead-letter queue.
- No priority scheduling.
- No metrics.

Documentation:

- [docs/architecture/architecture-overview.md](docs/architecture/architecture-overview.md) - High-level system architecture, runtime flow, module responsibilities, dependency boundaries, completed capabilities, and deferred architecture.
- [docs/architecture/domain-model.md](docs/architecture/domain-model.md) - Core domain objects, ownership, lifecycle, relationships, and future extension boundaries.

Future execution reliability enhancement candidates:

- Exponential backoff and delay strategies.
- Timeout handling.
- Cancellation.
- Idempotency.
- Error classification.
- Observability and retry metrics.
- Production startup wiring for Worker Runtime.
- Multi-worker coordination.

Phase 3H Durable Queue Lease Lifecycle
Status: Completed

Phase 3F Durable Queue reliability status:

- Durable Queue is feature-gated by `TRANSLATION_DURABLE_QUEUE_ENABLED`.
- The default behavior is disabled. When disabled, Translation Command keeps
  using the active in-memory `TranslationExecutionQueue` path only.
- When enabled, production composition creates a file-backed durable queue
  repository and wraps the active queue with dual-write enqueue persistence.
- When enabled, Worker Runtime startup runs durable queue recovery before worker
  polling starts.
- Queue item identity is `executionId` across the durable and active queues.
  Re-enqueueing the same `executionId` and `requestId` is idempotent; pairing an
  existing `executionId` with a different `requestId` fails deterministically
  with `translation_execution_queue_item_conflict`.
- Startup recovery replays durable `queued` items in FIFO order. For an expired
  `processing` lease, it first checks execution and output state: `queued` and
  output-less `running` executions may replay. A `running` execution with an
  output is reconciled to `completed`, its durable item is marked completed and
  acknowledged; terminal, missing, and invalid state combinations remain
  durable and are not replayed.
- An expired `processing` item paired with a failed execution and no output is
  marked failed and acknowledged without changing the execution or failure.
  Failed durable items retry acknowledgement only for the same failed/no-output
  state.
- Workers only process persisted `queued` executions. `created`, `running`,
  `completed`, and `failed` executions are skipped without provider invocation.
- The Worker acknowledges and removes a durable item only after the execution
  has been persisted as `completed` or `failed`, using the lease-aware
  `acknowledgeClaim(executionId, { leaseId })` API. Startup terminal
  reconciliation uses the separate system `acknowledge(executionId)` API.
- A processing item with an active `leaseExpiresAt` remains durable and is not
  replayed. An expired lease is cleared, requeued, and must be claimed anew by
  a Worker before provider execution.
- `TranslationOutput` persistence is idempotent by execution ID: the first
  output remains authoritative and later writes do not overwrite it.
- The HTTP `202 Accepted` contract and existing FIFO queue behavior are
  unchanged.

Architecture:

```text
HTTP Request
      │
      ▼
TranslationExecutionQueue
      │
      ├── In-Memory Queue (Active)
      │
      └── Durable Queue Repository (Feature-gated)
```

Startup Recovery:

```text
Worker Startup

↓

Startup Recovery

↓

Replay Durable Queue

↓

Worker Polling
```

Feature flags:

- `TRANSLATION_DURABLE_QUEUE_ENABLED`: defaults to disabled. Set to `true` to
  enable dual-write enqueue persistence and startup recovery.
- `TRANSLATION_DURABLE_QUEUE_FILE`: optional durable queue file path. When
  omitted, the default file is `translation-execution-queue.json`.

Current Durable Queue limitations:

- Completed reconciliation acknowledges only an output-bearing execution; it
  does not infer results for missing-output or mismatched durable items. Failed
  reconciliation requires no output and preserves the original failure.
- No retry delay scheduling, wake-up, or dead-letter transfer.
- No lease renewal or heartbeat, and no execution fencing after a lease expires.
- No multi-worker locking or cross-process deduplication policy.
- Provider-level idempotency keys and event-publishing deduplication are out of
  scope.
