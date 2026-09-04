# Live Translate Architecture

## System Architecture

Live Translate uses a browser-first real-time path with a narrow backend service.

- Frontend: React + JavaScript, Web Audio API, and Gemini Live API client logic.
- Backend: Node.js HTTP server for authentication, token issuance, and
  configuration validation.
- Gemini: Gemini Live API using `gemini-3.5-transcribe-live` for the current
  source transcription path; the speech-to-speech preview model is optional
  future capability.

The browser connects directly to Gemini Live API using an ephemeral token issued
by the backend.

The backend is responsible only for authentication, token issuance, and
configuration validation.

Audio streams are not proxied through the backend.

## Realtime subtitle pipeline (target architecture)

The current implementation and the target design must be kept distinct. The
current Live recorder uses `LiveTranscriptionSession` and persists source Cues;
the following is the planned downstream pipeline and is not yet a production
runtime change:

```text
Transcribe Live (`gemini-3.5-transcribe-live`)
  → finalized source Cue
  → Translation Worker (`gemini-3.5-flash`)
  → Refinement Worker (`gemini-3.5-flash`)
  → history / export / summary
```

`gemini-3.5-live-translate-preview` remains an optional future speech-to-speech
capability. It is not the authoritative meeting text source.

Responsibilities and ownership:

- The Live provider owns interim and final transcription events. The
  `subtitleCues` boundary owns pairing, normalization, and the distinction
  between an interim preview and a finalized Cue.
- The checkpoint/repository owns finalized Cue persistence and recovery state.
  Queue items own execution identity and delivery state; they do not own Cue
  identity or transcript text.
- The backend translation worker consumes `final_cue.persisted`, creates the
  initial translation execution, validates the structured result, and appends
  it to the same `cueId`.
- The refinement worker consumes a completed initial translation, sends the
  Cue plus bounded finalized context to Flash, validates the result, and
  applies a same-Cue version update. A Viewer broadcaster publishes safe
  finalized-Cue and same-Cue update events after the owning persistence step.
- History, export, and summary read finalized Cues and choose the effective
  translation as `refinedTranslation → initialTranslation → legacy
  translatedText`.

Interim text is UI-only and never enters persistence, translation, refinement,
export, history, or summary. Translation/refinement failures are recorded as
execution failures and surfaced for retry; they cannot pause or fail the Live
transcription session.

Cue immutable fields are `cueId`, `sessionId`, `segmentId`, `sequence`,
`startTimeMs`, `endTimeMs`, and `sourceText` (plus language identity). Only
translation/refinement values, versions, status, and safe execution metadata
may change. Stale or duplicate worker output is ignored by Cue version and
input-hash checks.

Lifecycle protection applies at every boundary: start and pre-roll establish
the session/segment checkpoint before audio is accepted; pause/resume flushes
final boundaries before replacing the Live connection; reconnect and rollover
restore the latest checkpoint and reject late events from the old connection;
terminal stop performs a final flush before history/export become readable.

## Direct Browser -> Gemini Live API Design

The browser streams microphone audio directly to Gemini Live API after receiving
a short-lived ephemeral token from the backend.

This design keeps the latency-sensitive audio path out of the backend and avoids
server-side audio relay costs for the MVP. The backend does not receive raw
microphone audio, translated audio, or transcript events.

## Backend Token Issuance Design

The backend exposes `POST /api/live-token`.

Responsibilities:

- Read and validate the requested target language.
- Read and validate the optional primary input language hint, defaulting to
  Traditional Chinese (`zh-Hant`) when omitted.
- Default `echoTargetLanguage` to `true` when omitted.
- Create a Gemini ephemeral token using `GEMINI_API_KEY`.
- Return only the ephemeral token name and expiration time to the browser.
- Map validation and provider failures to stable HTTP error responses.

The backend must not return the real Gemini API key or any long-lived credential.

## Frontend Responsibilities

- Render the translation controls and transcript display.
- Maintain explicit session state.
- Request microphone permission.
- Capture microphone audio with the Web Audio API.
- Convert microphone samples to raw PCM 16-bit 16kHz mono chunks.
- Request an ephemeral token from the backend.
- Connect directly to Gemini Live API with the ephemeral token.
- Send audio chunks to Gemini while the session is active.
- Play returned translated audio.
- Keep session-local original microphone audio and translated output audio
  available as browser-generated WAV downloads after the session ends.
- Upload finalized WAV audio artifacts to backend file storage so saved
  translation history can download original and translated audio after reload.
- Display input and output transcript updates.
- Stop microphone tracks and close the live session when the user stops.
- Surface recoverable errors to the user.

## Backend Responsibilities

- Serve `POST /api/live-token`.
- Validate request JSON.
- Validate `targetLanguageCode` against the allowlist.
- Validate optional `sourceLanguageCode` against the allowlist.
- Validate or default token configuration options.
- Use `GEMINI_API_KEY` only on the server.
- Create Gemini ephemeral tokens.
- Return consistent JSON responses.
- Support local frontend CORS configuration.

The backend must not proxy audio, store transcripts, or maintain session state in
the MVP.

Saved audio artifact persistence is separate from the live audio path. The
browser still streams live microphone audio directly to Gemini; only finalized
browser-generated WAV artifacts are uploaded after a session ends for later
history downloads.

## Translation Execution Durable Queue

When durable storage is enabled, the file-backed DLQ has a protected
administration path. Its application service reads items in repository order
and delegates single-item replay to the existing manual retry service. Replay
creates a new queued execution and never edits or removes the failed source or
DLQ item; worker leases, retry policy, fencing, and metrics are unchanged.

### Phase 4C Execution Control

`TranslationExecution` has terminal states `completed`, `failed`, and
`cancelled`. Only a persisted `queued` execution can transition to
`cancelled`; `running`, `completed`, `failed`, and `cancelled` executions are
not cancellable. Cancellation does not remove queue storage directly and is not
a remote abort of a running provider request.

A failed execution may be manually retried only by creating a new execution.
The source remains failed with its failure, attempt, and provider-attempt
metadata unchanged. The new execution has a new execution ID and provider
idempotency identity, retains the source `translationRequestId` / `requestId`
and `providerKey`, starts `queued`, and then follows the normal Worker/Runtime
lifecycle.

If a cancelled execution's identifier-only item remains in an active or durable
queue, Worker and recovery processing safely complete it as a no-op: no
resolver, Runner, provider, output, retry scheduling, or DLQ transfer occurs.
The durable path still observes the existing claim, lease, fence, and
acknowledgement ownership boundaries.

`POST /api/translation-executions` uses an asynchronous Translation Execution
path. The HTTP request persists a created execution, marks it queued, enqueues an
identifier-only job, and returns `202 Accepted` without waiting for provider
execution.

Phase 3C adds a feature-gated Durable Queue foundation:

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

Components:

- `TranslationExecutionQueue`: application queue port for `enqueue`,
  `dequeue`, and `size`.
- `DualWriteTranslationExecutionQueue`: feature-enabled adapter that writes the
  durable repository first, then enqueues the active in-memory queue.
- `DurableTranslationExecutionQueueRepository`: durable repository port for
  `enqueue`, `peek`, `list`, `dequeue`, `size`, `clear`, `updateStatus`,
  system `acknowledge`, lease-aware `acknowledgeClaim`, `contains`, and atomic
  `claim`.
- `FileDurableTranslationExecutionQueueRepository`: JSON file-backed repository
  adapter storing FIFO items with `executionId`, `requestId`, ISO UTC
  `enqueuedAt`, durable queue item `status`, and complete processing lease
  metadata: `leaseId` and `leaseExpiresAt`.
- `StartupTranslationExecutionQueueRecovery`: startup recovery service that
  replays durable items into the active in-memory queue before Worker Runtime
  polling begins.

Durable queue item lifecycle status is separate from the
`TranslationExecution` domain lifecycle. Durable queue items support only:

- `queued`
- `processing`
- `completed`
- `failed`

New durable queue items are stored as `queued`. Older persisted items without a
`status` field are normalized to `queued` when loaded; unknown or invalid
statuses are rejected.

Phase 3E applies the following defence-in-depth order without changing the
queue port, FIFO behavior, or the HTTP `202 Accepted` submission contract:

1. `executionId` is the durable and active queue item identity; an identical
   `requestId` is the same item, while a different one fails with
   `translation_execution_queue_item_conflict`.
2. Durable enqueue is idempotent and retains the original FIFO position,
   status, lease, timestamps, and persisted fields.
3. Active in-memory enqueue uses the same identity rule and retains one active
   item until dequeue.
4. Startup recovery filters durable status and can safely replay the same FIFO
   batch repeatedly without adding active duplicates.
5. The Worker checks persisted execution lifecycle before claim or provider
   execution.
6. Output persistence is idempotent by `executionId`; the first output remains
   authoritative.

| Execution / durable state | Behavior |
| --- | --- |
| `queued` | Recovery may replay it in FIFO order; the Worker may claim and execute it. |
| `processing` | Recovery requeues only when its `leaseExpiresAt` has expired; active leases remain durable. |
| `completed` | Recovery does not replay it; the Worker skips a completed execution. |
| `failed` | Recovery does not replay it; the Worker skips a failed execution. |
| `created` / `running` execution | The Worker skips it and does not call the provider. |

Durable execution ownership is `leaseId + fenceToken + leaseExpiresAt` on the
durable item; durable identity remains `executionId + requestId`. `leaseId`
identifies the claimant, `fenceToken` is the monotonically increasing claim
generation, and `leaseExpiresAt` determines whether recovery may reclaim it.

Durable lease lifecycle:

```text
queued
  → Worker claim(leaseId, fenceToken, leaseExpiresAt)
  → processing
  → heartbeat renewal
  → Runner output / terminal persistence guarded by leaseId + fenceToken
  → acknowledgeClaim(leaseId, fenceToken)
  → remove
```

Startup recovery:

```text
Worker Startup

↓

Startup Recovery

↓

Replay Durable Queue

↓

Claim Durable Queue Item

↓

Worker Polling
```

Replay uses `list -> active enqueue` to load durable items into the active
in-memory queue without removing them. Before a Worker executes a recovered or
newly enqueued job, it atomically claims the durable queue item from `queued`
to `processing` with a generated `leaseId` and `leaseExpiresAt`.
The Worker also retains `claimedAt` as compatibility metadata; recovery expiry
decisions use only `leaseExpiresAt`.
After the Runner persists a terminal `completed` or `failed` execution, the
Worker acknowledges the durable item and removes it only when its claim lease
and fence token match; startup reconciliation uses the system acknowledgement path.
If acknowledgement fails, the item remains stored and the acknowledgement error
propagates unchanged.

Configuration:

- `TRANSLATION_DURABLE_QUEUE_ENABLED` defaults to disabled. When enabled, it
  activates dual-write enqueue persistence and startup recovery.
- `DATA_DIR` selects the default directory for file-backed persistence. It
  defaults to `./data` outside production and `/var/data` in production.
- `TRANSLATION_DURABLE_QUEUE_FILE` optionally selects the JSON durable queue
  file. When omitted, the default is `translation-execution-queue.json` under
  `DATA_DIR`.
- `TRANSLATION_DEAD_LETTER_QUEUE_FILE` optionally selects the dead-letter queue
  file. When omitted, the default is
  `translation-execution-dead-letter-queue.json` under `DATA_DIR`.
- `TRANSLATION_QUEUE_LEASE_MS` defaults to `300000` milliseconds.
- `TRANSLATION_QUEUE_LEASE_RENEWAL_MS` configures the heartbeat renewal interval.

Recovery replays `queued` items in FIFO order. For an expired `processing` item
with complete lease metadata, it first loads the execution and its outputs. A
`queued` execution reuses the existing requeue path. A `running` execution with
no output uses the explicit domain recovery transition back to `queued`, then
requeues. A `running` execution with an output uses the existing command
service `complete` transition, then marks and acknowledges the durable item as
`completed`; it never replays the provider. A completed execution with output
and an expired processing item follows the same durable finalization path.
Missing executions, failed executions with output, active leases, and mismatched
output state remain unchanged and are not replayed.
An expired processing item with a failed execution and no output retries its
claim-guarded DLQ transfer without provider replay; its execution failure
metadata is never rewritten. The DLQ write is idempotent by `executionId` and
precedes removal from the durable queue.
Conflicting persisted identities fail before replay.

Provider attempt state is persisted independently as
`not_started → in_flight → succeeded | failed`. Successful execution writes:

```text
persist in_flight
→ provider call
→ persist succeeded + providerResult snapshot
→ persist output
→ persist execution completed
→ durable acknowledgement
```

Recovery reconciles `succeeded + providerResult` without resending the provider:
it fills a missing output and completes the execution. Expired `in_flight` work
may replay only when the resolved provider declares `idempotency.mode:
guaranteed`; `unknown` and `unsupported` remain durable without replay. Gemini
is `unknown` despite receiving `metadata.idempotencyKey`. Lease and fence token
checks protect attempt snapshots, output, completion, and acknowledgement from
stale owners.

Lease renewal and fenced persistence are cooperative checks at separate durable
queue and translation-repository boundaries; no cross-storage transaction is
provided. Durable Workers may atomically requeue an owned transient provider
failure with retry metadata and return its running execution to `queued`; delay
scheduling is driven by the Worker Runtime from `availableAt`. Terminal failures
are persisted before a claim/fence-checked DLQ transfer; a failed transfer keeps
the durable item for recovery.

The file-backed queue and DLQ repositories use sidecar directory locks to
serialize read-modify-write operations across Node.js processes on the same
host. Queue writes use a process-unique temporary file followed by an atomic
rename. Lock acquisition has a bounded wait and stale-lock recovery. Queue
operations retain their existing lease and fence checks, so a process that
loses ownership cannot acknowledge, retry, renew, or transfer an item. This
provides single-host multi-process atomicity, not cross-host coordination or
exactly-once provider delivery. Cross-storage queue/DLQ transfer remains
recoverable rather than transactional.

Before provider execution, the Worker reads the persisted execution and request.
Only `queued` executions proceed to durable claim and provider work; `created`,
`running`, `completed`, and `failed` executions return an
`execution_not_processable` skip result without changing queue durability,
execution state, or outputs.

`TranslationOutput` persistence is idempotent by `executionId`: the first
output is retained, and later create attempts for the same execution return the
persisted output without changing its content, metadata, or timestamps.

Current limitations:

- Completed reconciliation cannot infer terminal success without a persisted
  output; missing-output or mismatched execution/durable state remains durable.
- Failed reconciliation is limited to failed executions with no output; a
  failed execution that has output remains durable for manual investigation.
- Locking is limited to file-backed repositories on one host.
- These safeguards do not provide cross-host exactly-once delivery.
- Provider external idempotency keys and event-publishing deduplication remain
  out of scope.

Queue reliability metrics are process-local and are exposed through the
authenticated `GET /api/metrics` read model. The registry records queue depth,
worker outcomes, retry/DLQ activity, recovery, lease errors, acknowledgement
errors, and the last successful processing timestamp. Metrics are best-effort;
metric update failures never change queue or translation behavior.

## Gemini Live Session Flow

1. User starts a session in the browser.
2. Browser requests microphone permission.
3. Browser posts token options to `POST /api/live-token`.
4. Backend validates the request and creates an ephemeral token.
5. Browser opens a Gemini Live API session using the ephemeral token.
6. Browser sends input audio chunks to Gemini.
7. Gemini returns translated audio and transcript events.
8. Browser plays audio and updates transcripts.
9. User stops the session or the session ends.
10. Browser closes the Gemini session and stops microphone tracks.

TODO: Confirm the exact Gemini Live API client method names and event payload
shapes against the current official SDK before implementation changes.

## Audio Pipeline

Input to Gemini:

- Raw PCM.
- 16-bit signed integer.
- 16kHz.
- Mono.
- Little-endian.
- Sent in roughly 100ms chunks.

Output from Gemini:

- Raw PCM.
- 16-bit signed integer.
- 24kHz.
- Mono.
- Little-endian.

Frontend pipeline:

1. Capture microphone input.
2. Read floating-point PCM samples from the browser audio graph.
3. Resample to 16kHz if the input device uses a different sample rate.
4. Convert samples to little-endian PCM16 bytes.
5. Send chunks to Gemini Live API.
6. Decode Gemini output audio bytes.
7. Schedule translated audio playback at 24kHz.

## Frontend State Machine

- `idle`: No active session.
- `requesting-permission`: Browser microphone prompt is active.
- `connecting`: Token request or Gemini session setup is active.
- `listening`: Microphone audio is being translated.
- `stopped`: User stopped the session.
- `error`: Recoverable error with retry available.

Expected transitions:

- `idle` -> `requesting-permission` when the user starts.
- `requesting-permission` -> `connecting` after microphone access is granted.
- `requesting-permission` -> `error` if permission is denied.
- `connecting` -> `listening` after Gemini session setup succeeds.
- `connecting` -> `error` if token creation or session setup fails.
- `listening` -> `stopped` when the user stops.
- `listening` -> `error` when an unrecoverable session error occurs.
- `error` -> `idle` when the user retries or resets.

## Error Recovery Strategy

- Permission denied: stop setup, show a clear recoverable error, and allow retry.
- Invalid target language: show validation failure and keep the user out of an
  active session.
- Token issuance failure: stop setup and allow retry.
- Gemini session connection failure: close any partial session, stop microphone
  tracks, and allow retry.
- Audio playback failure: stop the session and show a recoverable error.
- Session ended by Gemini: stop microphone tracks and move to `stopped` or
  `error` depending on whether the end was expected.

## Phase 4A Translation Closeout

Translation history is a session-scoped, read-only query path:

```text
GET /api/sessions/:sessionId/translations?targetLanguageCode=<supported code>
  → TranslationHistoryQueryService
  → session repository + translation repository reads
  → request / execution / output / sourceLanguageDetection view model
```

It does not invoke a provider, queue, worker, runner, or glossary loader and
performs no writes. A session may retain multiple requests for the same target
language. Empty history, queued/failed execution, missing output, and legacy
source items without detection metadata are all valid read states.

`TranscriptItem.sourceLanguageDetection` is the canonical optional metadata
flow for mixed-language observations. It may contain multiple language codes;
Gemini does not yet provide guaranteed reliable segment-level detection.

The optional file glossary is loaded only by production provider composition and
is added to provider instructions for the selected target language. It must not
rewrite canonical source text, request snapshots, or persisted output.

## Phase 4B Formal Outputs and History

`TranslationOutput` is the authoritative completed-translation record. Formal
versions increase monotonically within `(sessionId, targetLanguageCode)`;
different languages and different Sessions each begin at v1. Queued,
processing, and failed executions create no output and consume no version. An
execution is output-idempotent: retry, recovery, reclaim, or re-entry retains
at most one output and its original version.

The durable queue stores scheduling and claim state plus identifiers only. The
persisted `TranslationRequest` remains authoritative for canonical source,
target language, and source provenance; Workers and recovery reload it by
`requestId`. Lease and fence ownership guard output persistence, completion,
and acknowledgement. Local output idempotency prevents duplicate persisted
outputs, but Gemini's provider-side idempotency for a reclaimed execution is
`unknown` and no remote de-duplication is guaranteed. Terminal failure creates
no output, and DLQ transfer does not invoke a provider.

For Session detail, formal outputs take precedence over the legacy fallback.
Completed outputs and pending/failed executions are shown separately. The UI
polls only while work is pending; session changes, unmount, and newer refreshes
discard stale responses, and a selected output remains selected unless it no
longer exists. TXT/SRT/VTT export uses the selected formal output. Legacy-only
Sessions retain the existing compatibility read model and exporter.

## Security Considerations

- `GEMINI_API_KEY` must stay on the backend.
- The browser may receive only short-lived ephemeral tokens.
- Ephemeral tokens should be scoped to the Live Translate model and required
  session configuration.
- Token requests must validate `targetLanguageCode` and optional
  `sourceLanguageCode`.
- Backend CORS should be restricted to the local frontend origin in development
  and the production frontend origin in deployment.
- The backend should not log secrets, raw audio, or transcript content.
- The backend should not proxy, store, or inspect live audio streams in the MVP.

## Frontend Project Structure

Route pages are kept in `src/pages/`. Capability-specific frontend code is
kept in `src/features/`, including feature UI, API clients, and browser-side
orchestration. Cross-feature presentational components belong in
`src/components/`; only genuinely shared pure helpers belong in `src/lib/`.
Backend-facing business workflows remain in `src/application/`, domain rules
in `src/domain/`, and external adapters in `src/infrastructure/`.

The application composition root is `src/app/App.jsx`. It owns cross-feature
state wiring and the existing Live session workflow. Workspace page composition
is provided by `src/features/workspace/WorkspacePage.jsx`; Meeting, Glossary,
and History UI are exposed through feature entry points under
`src/features/{meetings,glossary,history}/`. These entry points are the stable
migration boundary for extracting page-specific controllers and hooks without
changing route wiring.

The current frontend structure follows this pattern:

```text
.
├── docs/
│   ├── spec.md
│   ├── architecture.md
│   ├── api.md
│   ├── development.md
│   └── decisions.md
├── server/
│   ├── index.js
│   ├── languages.js
│   └── tokenService.js
├── src/
│   ├── components/
│   ├── features/
│   │   ├── deadLetterQueue/
│   │   ├── history/
│   │   └── live/
│   ├── pages/
│   │   ├── admin/
│   │   ├── glossary/
│   │   ├── history/
│   │   ├── live/
│   │   ├── meetings/
│   │   └── viewer/
│   ├── lib/
│   │   ├── audio.js
│   │   ├── languages.js
│   │   └── liveSession.js
│   ├── main.jsx
│   └── styles.css
├── tests/
│   ├── audio.test.js
│   └── tokenService.test.js
├── .env.example
├── package.json
└── vite.config.js
```
