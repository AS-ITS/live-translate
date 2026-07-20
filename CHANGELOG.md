# Changelog

## Unreleased

### Added

- Phase 3F Documentation Closeout: documented the durable acknowledgement
  contract and terminal cleanup: items are removed only after `completed` or
  `failed` execution persistence, while acknowledgement failures retain the
  item and propagate unchanged. Startup recovery now replays only `queued`
  items; `processing`, `completed`, and `failed` items remain stored without
  replay or removal. Production-composition integration coverage verifies
  successful and failed terminal cleanup, recovery eligibility, and
  acknowledgement-failure retention with a fake provider. Processing-item
  crash recovery; lease, heartbeat, and visibility-timeout recovery policy;
  retry/backoff; dead-letter queues; and multi-worker locking or cross-process
  deduplication policy remain deferred.
- Phase 3E WP8 Documentation Closeout: documented durable and active queue
  identity, idempotent enqueue and recovery, lifecycle safeguards, output
  uniqueness, and production-composition vertical coverage. The README,
  architecture documents, and roadmap now record the remaining limitations:
  no multi-process exactly-once delivery, provider idempotency, or event
  publishing deduplication.
- Phase 3E WP7 Deduplication & Recovery Vertical Integration Tests: added
  production-composition coverage with a fake provider for duplicate durable
  submission, repeated FIFO recovery, terminal durable items, and worker
  lifecycle skips. The scenarios verify a single provider invocation and
  output per processable execution without external API calls.
- Phase 3E WP6 Output Uniqueness Protection: translation output persistence is
  now idempotent by execution ID. The first output remains authoritative, and
  later create attempts return it without overwriting content, metadata, or
  timestamps.
- Phase 3E WP5 Worker Lifecycle Guard: workers now return an
  `execution_not_processable` skip result for persisted created, running,
  completed, or failed executions. Skipped jobs load their request but do not
  claim or change durable items, invoke providers, create outputs, or update
  execution lifecycle state.
- Phase 3E WP4 Idempotent Startup Recovery: recovery now rejects conflicting
  persisted queue identities before replay or lease release, replays only
  queued and lease-expired processing items, and leaves completed and failed
  items untouched. Repeated recovery relies on active queue idempotency to
  preserve a single FIFO work item without changing durable item metadata.
- Phase 3E WP3 Active In-Memory Queue Deduplication: active execution queue
  enqueue now uses the shared durable identity contract. Matching identities are
  no-ops that retain FIFO order; conflicting request identities fail with
  `translation_execution_queue_item_conflict`; executions may be enqueued again
  after dequeue. Dual-write and recovery coverage verifies no duplicate active
  work is created.
- Phase 3E WP2 Idempotent Durable Enqueue: durable repository enqueue now
  explicitly preserves the existing item as a no-op for matching queue item
  identity. Repeated writes retain FIFO position, status, lease, timestamps,
  and all persisted fields, including after file-backed repository reload.
- Phase 3E WP1 Durable Queue Identity Contract: centralized durable queue item
  identity comparison on `executionId` and `requestId`. Re-enqueueing the same
  identity preserves the existing no-op behavior, while an existing
  `executionId` paired with a different `requestId` now fails deterministically
  with `translation_execution_queue_item_conflict`. The fake and file-backed
  repositories share contract coverage, including file reload semantics; FIFO,
  status lifecycle, and JSON persistence format remain unchanged.
- Phase 3D WP5 Lease & Visibility Timeout: durable queue items now persist an
  optional `leasedUntil` timestamp, legacy items load with no lease, and the
  repository supports claim, expiry inspection, and expired-lease release.
  Workers acquire a five-minute configurable lease before processing; startup
  recovery releases expired leases and replays only eligible queued or expired
  processing items. No renewal, retry, distributed locking, or multi-worker
  coordination was added.
- Phase 3D WP4 Durable Queue Deduplication: added read-only
  `contains(executionId)` to the durable queue repository contract and its fake
  and file-backed adapters. Durable enqueue is now idempotent by execution ID;
  duplicate writes preserve the original item, status, and FIFO order. The
  dual-write queue checks durable existence before enqueueing the active queue,
  and startup recovery replays each execution at most once across repeated
  recovery calls without removing durable items. Acknowledgement still permits
  a later enqueue of the same execution. No distributed locking, lease,
  visibility timeout, retry, transactional enqueue, or multi-worker behavior
  was added.
- Phase 3D WP3 Completion Acknowledgement: extended the durable queue
  repository contract and its fake and file-backed adapters with
  `acknowledge(executionId)`, which removes an existing durable item while
  preserving remaining FIFO order and fails deterministically for missing
  items. The Translation Execution Worker now claims an item, runs the Runner,
  and acknowledges only after the Runner completes or fails, so durable items
  remain through startup replay and terminal execution persistence. An
  acknowledgement error propagates unchanged without retrying the Runner or
  provider; a runner failure is still rethrown after successful cleanup. No
  retry, acknowledgement retry, lease, visibility timeout, deduplication,
  multi-worker support, distributed locking, or transactional persistence was
  added.
- Phase 3D WP2 Worker Claim: wired the durable queue repository into the
  Translation Execution Worker when the durable queue feature is enabled, so the
  Worker now persists a durable queue item claim by updating `queued` to
  `processing` before starting the runner. Claim failures propagate unchanged
  and prevent runner/provider execution. Startup recovery now replays durable
  items with `list -> active enqueue` and no longer removes them during replay,
  leaving durable removal for future acknowledgement work. No HTTP API,
  `TranslationExecution` lifecycle, provider behavior, retry, lease, visibility
  timeout, recovery filtering, deduplication, dead-letter queue, locking, or
  multi-worker coordination was added.
- Phase 3D WP1 Durable Queue Item Lifecycle: added a centralized immutable
  durable queue item status set with `queued`, `processing`, `completed`, and
  `failed`, defaulted new durable queue items to `queued`, and extended the
  durable queue repository contract with `updateStatus`. The fake and
  file-backed durable queue repositories now persist status updates without
  changing item identity, payload, ordering, or item count, reject invalid
  statuses, and fail deterministically for missing items. File-backed storage
  remains backward compatible for older items without `status` by loading them
  as `queued`, while invalid persisted statuses remain storage errors. No
  Worker claim, runtime transition, acknowledgement, completion-driven removal,
  retry, lease, visibility timeout, dead-letter queue, startup recovery
  filtering, HTTP API, provider execution, or `TranslationExecution` lifecycle
  behavior changed.
- Phase 3C WP7 Documentation Closeout: updated README, ROADMAP, architecture
  overview, and the main architecture document to reflect the current Durable
  Queue foundation, including feature-gated composition, dual-write enqueue
  persistence, file-backed durable repository storage, startup recovery, replay
  flow, and Phase 3C completion. The documentation now explicitly records the
  current limitations: durable items are removed immediately after startup
  replay into the active queue, and acknowledgement, completion-driven removal,
  replay deduplication, lease, visibility timeout, retry, dead-letter queue,
  multi-worker support, locking, and concurrency control remain future work. No
  production runtime, Worker, queue, repository, recovery, replay, HTTP API,
  configuration, execution lifecycle, or test behavior changed.
- Phase 3C WP6 Startup Recovery / Durable Queue Replay: added the Startup
  Translation Execution Queue Recovery application service that replays durable
  queue items one at a time with `peek -> active enqueue -> durable dequeue`,
  preserves FIFO order, converts durable items back to the active queue
  `{ executionId, requestId }` schema, and stops with original error propagation
  on peek, active enqueue, or durable dequeue failures. Production composition
  now creates recovery only when `TRANSLATION_DURABLE_QUEUE_ENABLED=true` and
  wraps Worker Runtime startup so recovery completes before polling starts.
  Recovery targets the underlying in-memory primary queue used by the active
  dual-write queue. No HTTP API, execution lifecycle, Worker processing logic,
  acknowledgement, durable dequeue after success, replay deduplication, lease,
  visibility timeout, retry, dead-letter queue, reconciliation, locking,
  multi-worker, concurrency, or metrics behavior changed.
- Phase 3C WP5 Dual-write Enqueue Persistence: added the dual-write
  Translation Execution Queue adapter that writes durable queue items with
  deterministic `enqueuedAt` timestamps before enqueueing the existing
  in-memory primary queue, delegates `dequeue` and `size` only to the primary
  queue, preserves caller input immutability, and propagates durable and primary
  write failures unchanged without rollback or compensation. Production
  composition now uses the dual-write queue only when
  `TRANSLATION_DURABLE_QUEUE_ENABLED=true`, while the disabled path keeps the
  existing in-memory queue behavior. Feature-enabled vertical coverage verifies
  `POST /api/translation-executions` persists the durable item and enqueues the
  in-memory job without changing the HTTP `202` response shape, Worker Runtime,
  durable dequeue behavior, execution lifecycle, restart recovery, replay,
  acknowledgement, lease, retry, dead-letter queue, locking, concurrency, or
  metrics behavior.
- Phase 3C WP4 Production Composition Wiring: added Translation Queue
  Configuration for `TRANSLATION_DURABLE_QUEUE_ENABLED` and
  `TRANSLATION_DURABLE_QUEUE_FILE`, and wired production composition to create
  the file-backed durable queue repository only when the feature flag is
  enabled. The repository is exposed as
  `durableTranslationExecutionQueueRepository` for future work, while the
  active `TranslationExecutionQueue` remains the existing in-memory queue by
  default and when the durable repository is enabled. No durable queue
  activation, queue replacement, Worker Runtime integration, enqueue/dequeue
  persistence, worker replay, restart recovery, HTTP API, execution lifecycle,
  acknowledgement, lease, retry, dead-letter queue, concurrency, or metrics
  behavior changed.
- Phase 3C WP3 File-backed Durable Translation Execution Queue Repository:
  added the JSON file-backed durable queue repository adapter with async
  `enqueue`, `peek`, `dequeue`, `size`, and `clear`, pretty UTF-8 storage using
  deterministic item key order, full-file read/write semantics, FIFO behavior,
  reload persistence, and deterministic
  `invalid_translation_execution_queue_storage` failures for corrupted storage.
  The adapter passes the reusable durable queue repository contract and
  adapter-specific storage tests. No production composition, Worker Runtime,
  Worker, HTTP API, execution lifecycle, restart recovery, replay, file locking,
  acknowledgement, lease, retry, dead-letter queue, concurrency, or metrics
  behavior changed.
- Phase 3C WP2 Durable Translation Execution Queue Repository Contract: added
  the durable queue repository application port with `enqueue`, `dequeue`,
  `peek`, `size`, and `clear`, defined the durable queue item schema with
  `executionId`, `requestId`, and ISO UTC `enqueuedAt`, and added stable
  validation using `invalid_translation_execution_queue_item`. Added a fake
  in-memory durable queue repository plus reusable contract coverage for FIFO,
  peek without removal, dequeue removal, size, clear, empty queue `null`
  behavior, validation failure state preservation, input immutability, and
  immutable dequeue results. No production composition, Worker Runtime, HTTP
  API, execution lifecycle, durable storage, restart recovery, lease,
  acknowledgement, retry, dead-letter queue, concurrency, or metrics behavior
  changed.
- Phase 3C WP1 Translation Execution Queue Port Contract: tightened the
  Translation Execution Queue application port to the minimal `enqueue`,
  `dequeue`, and `size` contract, added stable queue-item validation with the
  `invalid_translation_execution_queue_item` code, normalized empty dequeue to
  `null`, and added reusable contract coverage for FIFO ordering, empty
  dequeue, size/removal semantics, validation failures, queue-state preservation,
  and input immutability. The production in-memory queue now passes the same
  contract tests. Runtime polling continues to use the same queue and worker
  lifecycle through `size()` without adding durable persistence, recovery,
  retry, lease, acknowledgement, dead-letter queue, concurrency, metrics, or
  HTTP behavior changes.
- Phase 3B WP6 Documentation Closeout: completed documentation for Queue
  Abstraction, Worker Runtime Lifecycle (`start`, `stop`, `restart`, and
  `isRunning`), Worker Loop behavior, graceful shutdown, production Runtime
  integration, and current limitations including no automatic Runtime startup,
  in-memory queue only, no durable or external queue, no retry, no timeout, no
  cancellation, no priority scheduling, no parallel workers, and no metrics.
  Updated README, ROADMAP, architecture overview, and changelog only. No
  production code, test logic, HTTP API, execution lifecycle, FIFO queue,
  Worker, Runtime, retry, timeout, cancellation, or external queue behavior
  changed.
- Phase 3B WP5 Runtime Integration: added production vertical integration
  coverage proving Queue, Worker, and Worker Runtime collaborate through the
  production composition graph. Coverage verifies `POST -> Queue -> Worker ->
  completed`, confirms queued executions remain `queued` while the Runtime is
  not started, proves Runtime start completes existing queue work, verifies
  Runtime stop leaves newly submitted work queued, and proves restart resumes
  remaining FIFO work. No HTTP API, execution lifecycle, FIFO queue, retry,
  timeout, cancellation, parallel worker, or external queue behavior changed.
- Phase 3B WP4 Graceful Shutdown: refined
  `TranslationExecutionWorkerRuntime.stop()` so it prevents future polling and
  new queue work while allowing an in-flight Worker execution to finish before
  the runtime reports stopped. Focused coverage verifies in-flight work
  completion, Worker Loop shutdown after the current job, queued work after
  stop remaining unprocessed, and restart processing the remaining queue work.
  No FIFO queue, HTTP API, execution lifecycle, retry, timeout, cancellation,
  automatic startup, or parallel worker behavior changed.
- Phase 3B WP3 Worker Loop: made `TranslationExecutionWorkerRuntime` poll the
  shared Queue abstraction before invoking the Worker, so an empty queue waits
  for the next scheduled poll without repeatedly executing idle worker work,
  while newly enqueued jobs are processed on later polls without restarting the
  runtime. Focused coverage verifies empty-queue waiting, automatic recovery
  after enqueue, FIFO processing across multiple jobs, and continued waiting
  after a job completes. No FIFO queue, HTTP API, execution lifecycle, retry,
  timeout, cancellation, graceful shutdown, or parallel worker behavior changed.
- Phase 3B WP2 Worker Runtime Lifecycle: added explicit
  `TranslationExecutionWorkerRuntime.isRunning()` state, verified safe
  start/stop/restart behavior, kept repeated `start()` from creating multiple
  polling loops, kept repeated or pre-start `stop()` safe, and wired production
  composition to create and expose the Worker Runtime without automatically
  starting it. No FIFO queue, HTTP API, execution lifecycle, retry, timeout,
  cancellation, graceful shutdown, or parallel worker behavior changed.
- Phase 3B WP1 Queue Abstraction: formalized the Translation Execution Queue
  application contract around `enqueue(item)`, `dequeue()`, `isEmpty()`, and
  `size()`, updated the in-memory FIFO queue to implement that contract,
  switched worker, command, and composition validation to the shared queue
  abstraction, and added focused contract coverage for FIFO dequeue order,
  empty dequeue behavior, queue size/emptiness state, alternate queue
  implementations, and production in-memory queue composition. No HTTP API,
  execution lifecycle, retry, timeout, cancellation, priority, parallel worker,
  or external queue behavior was added.
- Phase 3A WP10 Documentation Closeout: documented Async Execution Runtime,
  Queue / Worker architecture, `202 Accepted` asynchronous submission for
  `POST /api/translation-executions`, Worker Runtime polling behavior, and
  current implementation limitations including in-memory queue only, no
  automatic runtime startup, no durable queue, no cancellation, no timeout, no
  multi-worker processing, and no metrics. No production code, tests, HTTP
  contract, queue, worker, runner, retry policy, provider resolver, or
  persistence-format behavior changed.
- Phase 2P WP6 Documentation Closeout: completed Translation Execution
  Lifecycle documentation and closeout. README and ROADMAP now document the
  implemented `TranslationExecution` statuses (`created`, `queued`, `running`,
  `completed`, `failed`), the success lifecycle (`created`, `queued`,
  `running`, `completed`), the provider-failure lifecycle (`created`, `queued`,
  `running`, `failed`), provider execution after persisted `running`, output
  persistence before `completed`, no output on failure, unchanged provider-error
  propagation, and Phase 2P completion. No production code, tests, retry, queue
  runtime, timeout, cancellation, metrics, provider behavior, HTTP contract, or
  persistence-format behavior changed.
- Phase 2P WP5 Execution Lifecycle Vertical Integration: extended production
  composition vertical integration coverage to verify persisted
  `TranslationExecution` lifecycle order for successful execution (`created`,
  `queued`, `running`, `completed`) and provider failure (`created`, `queued`,
  `running`, `failed`). Coverage verifies `TranslationOutput` is created only
  on success, no output is created on failure, provider errors are propagated
  unchanged through the application boundary, and existing HTTP/provider
  behavior remains unchanged. No retry, queue runtime, timeout, cancellation,
  metrics, provider, or persistence-format behavior was added.
- Phase 2P WP4 Lifecycle Unit Test Consolidation: consolidated focused
  `TranslationCommandService` lifecycle coverage to assert exact persisted
  execution status order for success (`created`, `queued`, `running`,
  `completed`) and provider failure (`created`, `queued`, `running`, `failed`).
  Tests now explicitly verify provider execution happens only after `running`
  is persisted, `TranslationOutput` is persisted before `completed`, no output
  is created on provider failure, and the original provider error is rethrown
  unchanged. No production behavior, retry, queue runtime, timeout,
  cancellation, metrics, HTTP, provider behavior, or persistence format changed.
- Phase 2P WP3 Failure Execution Lifecycle: verified provider execution
  failures now use the persisted `created`, `queued`, `running`, and `failed`
  lifecycle introduced by WP2. The failed state is persisted after the provider
  throws, no `TranslationOutput` is created on failure, the original provider
  exception is rethrown unchanged, and provider invocation count remains
  unchanged. No retry, timeout, queue runtime, error mapping, metrics, HTTP, or
  provider behavior was added.
- Phase 2P WP2 Success Execution Lifecycle: updated
  `TranslationCommandService` successful provider execution orchestration to
  persist `TranslationExecution` transitions in `created`, `queued`, `running`,
  and `completed` order. Provider resolution, provider invocation input,
  invocation count, `TranslationOutput` persistence before completion, and
  failure persistence behavior remain unchanged. No queue runtime, retry,
  timeout, cancellation, metrics, HTTP, or provider behavior was added.
- Phase 2P WP1 Extend Translation Execution Status: updated the
  `TranslationExecution` domain lifecycle to support explicit `created`,
  `queued`, `running`, `completed`, and `failed` statuses, added the `queue()`
  transition method, preserved explicit `start()`, `complete()`, and `fail()`
  behavior, and added focused domain coverage for the new queued/running
  lifecycle and deterministic rejection of unsupported legacy statuses. No
  application orchestration, provider execution, HTTP, retry, queue runtime,
  timeout, cancellation, or metrics behavior was added.
- Phase 2O WP7 Documentation and Closeout: completed Production Gemini
  Translation Execution documentation and closeout. Added the concrete
  `GeminiTranslationExecutionProvider` production adapter for Translation
  Execution, wired production composition to create `GeminiClient`, wrap it in
  the Gemini execution provider, register it as `gemini`, and keep `gemini` as
  the default production provider when `TRANSLATION_PROVIDER` is unset. Test and
  supplied-provider composition continues to use
  `FakeTranslationExecutionProvider` without invoking the Gemini production
  path. Focused unit, composition, vertical integration, and error integration
  coverage now verifies request and response mapping, provider wiring, default
  `gemini` resolution, fake-provider isolation, successful
  `TranslationOutput` persistence and completed execution lifecycle, failed
  execution persistence, no output on provider failure, and unchanged
  `GeminiHttpError` propagation at the application boundary. No retry, timeout,
  streaming, metrics, logging, fallback, HTTP API, persistence schema, frontend
  behavior, or real Gemini API validation was added.
- Phase 2N WP5 Failure Mapping and Closeout: completed Gemini Translation
  Execution Provider closeout, including stable `GeminiHttpError` mapping for
  Gemini HTTP 400, 401, 403, 429, 5xx, and generic HTTP failures while
  preserving the existing exception propagation lifecycle and explicit invalid
  response errors. Documented that production Translation Command composition
  now supports the concrete `GeminiTranslationExecutionProvider` backed by
  `GeminiClient`, registers `gemini` through
  `TranslationExecutionProviderResolver`, uses `GEMINI_API_KEY` and
  `GEMINI_MODEL`, and has fake HTTP vertical integration coverage proving
  provider dispatch, `TranslationOutput` persistence, completed and failed
  execution lifecycles, and no real Gemini API call during automated tests.
  Fake provider and fake resolver coverage remains supported. Real Gemini API
  validation still requires configured credentials and remains outside
  automated closeout.
- Phase 2M WP4 Documentation Closeout: completed Runtime Provider Resolution
  documentation in README and ROADMAP, marking Phase 2M complete and recording
  the delivered `TranslationExecutionProviderResolver` runtime boundary,
  resolver-backed `TranslationCommandService` execution, default provider
  behavior, deterministic unknown-provider failure lifecycle, current supported
  provider keys (`fake` for supplied fake/test execution providers and `gemini`
  for the current production runtime wrapper), and current limitation that no
  additional real provider implementations, fallback, health checks, frontend
  provider controls, HTTP API changes, or retry policy changes were added.
  Focused regression validation covered the fake resolver, Translation Command
  service execution, production composition wiring, and production HTTP
  vertical integration. No production code changed.
- Phase 2L WP7 Documentation and Closeout: completed Execution Reliability
  documentation in README and ROADMAP, marking Phase 2L complete and recording
  the delivered `RetryPolicy` abstraction, `TranslationExecutionRunner`, retry
  execution, exhausted retry lifecycle, production composition wiring, and
  production vertical integration coverage. Current production composition uses
  the default `RetryPolicy(maxRetries = 0)`, so provider execution attempts
  remain exactly one on failure. Backoff, sleep, timers, scheduling, queue or
  worker execution, retry metrics, retry persistence, timeout handling,
  cancellation, environment-configurable retry policy, and HTTP contract changes
  remain future work.
- Phase 2L WP6 Vertical Integration: added production HTTP vertical
  integration coverage for the translation execution reliability path through
  `TranslationCommandController`, `TranslationCommandService`,
  `TranslationExecutionRunner`, `ProductionTranslationExecutionProvider`,
  provider resolution, and repository persistence. The tests prove successful
  execution resolves and executes the provider once, persists one output,
  completes once, preserves explicit and omitted `providerKey` attribution, and
  does not forward `providerKey` into resolved provider input. Provider failure
  coverage proves the default production retry policy remains `maxRetries = 0`,
  provider attempts remain exactly one, failed execution persistence happens
  once, no output or completed state is persisted, fallback provider execution
  does not occur, the original provider error is preserved at the application
  boundary, and the existing generic HTTP 500 contract is unchanged.
- Phase 2L WP5 Composition Wiring: wired production translation command
  composition to create the default `RetryPolicy`, build a
  `TranslationExecutionRunner` with the `TranslationRepository`,
  production `TranslationExecutionProvider`, and default policy, and inject the
  runner into `TranslationCommandService`. The default policy remains
  `maxRetries = 0`, so production execution still performs no retries and no
  retry runtime configuration, backoff, timers, queue, logging, metrics, or
  persistence behavior was added.
- Phase 2L WP4 Exhausted Retry Failure Semantics: verified
  `TranslationExecutionRunner` keeps executions active through retryable
  intermediate provider failures, persists exactly one failed execution only
  after retry exhaustion, creates no `TranslationOutput`, writes no completed
  state, stops at `1 + maxRetries` provider attempts, and rethrows the final
  provider error by identity. Default `maxRetries = 0` behavior remains a
  single provider attempt followed by the existing failed-execution persistence.
- Phase 2L WP3 Retry Execution: added retry execution inside
  `TranslationExecutionRunner` using the injected `RetryPolicy`, retrying
  provider execution until success or retry exhaustion, calling `nextDelay()` for
  future compatibility without sleeping or scheduling, persisting exactly one
  `TranslationOutput` and one completion on success, and marking the execution
  failed only after retries are exhausted. The default production policy remains
  `maxRetries = 0`, so production runtime behavior is unchanged unless a
  different policy is explicitly injected. No backoff, timers, scheduling,
  queue, worker, cancellation, retry metrics, retry persistence, HTTP, or
  composition behavior was added.
- Phase 2L WP2 TranslationExecutionRunner: extracted provider execution
  orchestration from `TranslationCommandService` into a dedicated
  application-layer runner that owns provider invocation, `TranslationOutput`
  creation, completion persistence, and failure persistence while accepting the
  new `RetryPolicy` as configuration only. `TranslationCommandService` now
  delegates provider execution through the runner, preserving the existing
  execution lifecycle, domain-event publication, repository behavior, and
  no-retry default runtime semantics. No retry loop, backoff, scheduling,
  queue, worker, HTTP, repository, provider, or composition wiring behavior was
  added.
- Phase 2K WP6 Documentation and Regression Closeout: completed Production
  Translation Runtime documentation, marked Phase 2K completed in the roadmap,
  documented Phase 2L Execution Reliability as the next phase, and recorded the
  completed production runtime port, resolver-backed runtime adapter,
  production composition wiring, runtime vertical integration, and runtime
  failure lifecycle. Focused regression validation covered the production
  runtime port, adapter, composition root, command-service execution, and
  vertical integration. No production runtime behavior changed.
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
