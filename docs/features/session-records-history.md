# Session Records & Translation History

## Feature Overview

Session Records & Translation History is a Phase 2 capability for defining the
session record model, translation history foundation, session-to-transcript
relationship, and repository abstraction.

Status: Slice 5 implemented with a finalized history list, inline session
detail, saved-session export, finalized-record delete, and saved-retranslation
output delete backed by the repository boundary. The UI exposes history through
a separate `#history` feature page; live translation remains on `#live`.

This capability creates the planning boundary for saving and reopening completed
translation sessions without selecting a storage engine, adding backend APIs,
adding access control, or changing the Gemini Live session flow. It should build
on the existing transcript, export, lifecycle, device-selection, and failure
classification foundations while keeping the active live session behavior
separate from saved history.

Domain direction note:

- A Session is not just a single translation result.
- A future Session can contain multiple Translation Outputs.
- The current Slice still uses a single target language implementation.
- Multi-output and re-translation remain future extension work.

## Goals

- Define `SessionRecord` model.
- Define the relationship between `TranscriptItem` and `SessionRecord`.
- Define mapping from session lifecycle events to session record updates.
- Define `SessionRepository` interface.
- Support the conceptual boundary for list, detail, and delete behavior.
- Support finalizing the current session into history.
- Keep history review separate from the live translation workspace while
  preserving in-memory detail, export, and pending-execution state when moving
  between the two feature pages.
- Do not decide the storage engine.
- Do not add backend APIs.
- Do not add access control.

## Non-Goals

- Search.
- Bookmarks.
- Usage metrics.
- Diagnostics dashboard.
- Login or access control.
- Backend persistence.
- Raw audio storage.
- Transcript editing.
- Gemini Live session flow changes.
- Reconnect or token refresh behavior changes.

## Current Foundation

### Transcript Engine

Better Transcript Handling already defines a stable frontend transcript item
shape with separate `source` and `translation` streams, `partial` and `final`
states, monotonic `sequence` ordering, frontend timestamps, and duplicate
handling. Session history should reuse this shape instead of reinterpreting raw
SDK events.

### Transcript Export

Transcript Export already formats current-session transcript items as TXT, SRT,
and VTT without backend APIs or persistence. Saved-session export should reuse
the same formatter boundary and should operate on saved transcript items rather
than raw session events.

### Session Lifecycle

Session Lifecycle Management defines the explicit session states, close/error
reasons, cleanup rules, and UI mapping for `idle`, `requesting-permission`,
`connecting`, `listening`, `stopping`, `stopped`, `error`, `reconnecting`, and
`expired`. Session records should map from this lifecycle model instead of
creating a separate state system.

### Connection Resilience

Connection Resilience provides retry, reconnect, token-expiration UX readiness,
failure-state mapping, and controlled reconnect for `unexpected_close`.
Session records may capture failure metadata and reconnect counts, but this
capability must not own reconnect orchestration or token refresh behavior.

### Audio Input Device Selection

Audio Input Device Selection v1 already handles browser-local microphone
selection and fallback behavior. Session records may store a snapshot of the
selected input device preference for review, but they must not manage device
enumeration, selection, or active-session device changes.

### Failure Classification

Failure Classification defines stable internal failure categories and reasons
for permission, token, network, provider, browser runtime, audio device, user
intent, cleanup, and unknown failures. Session records should store normalized
failure reason/category values, not raw SDK errors or sensitive diagnostics.

### Session / Translation Future Shape

The future domain model separates the canonical Source Transcript from one or
more Translation Outputs. Saved history should eventually reopen the Session as
an aggregate rather than treating each target language as a fully independent
history item.

Current implementation remains a single-output representation with one active
`targetLanguageCode` per record. That is intentional for Phase 2A and should not
be interpreted as the final domain shape.

## SessionRecord Model Draft

Field names and exact serialization should remain draft-level until the storage
adapter is selected.

### Required

- `id`: Stable record identifier.
- `startedAt`: Timestamp when the recorded live session began.
- `endedAt`: Timestamp when the recorded live session reached a terminal state.
- `durationMs`: Computed duration between `startedAt` and `endedAt`.
- `targetLanguageCode`: Selected target language code for the session.
- `status`: Final or current record status, such as `active`, `completed`,
  `stopped`, `failed`, or `expired`.
- `failureReason`: Nullable lifecycle or failure-classification reason, such as
  `user_stop`, `unexpected_close`, `token_expired`, or `cleanup_failed`.
- `createdAt`: Timestamp when the record was created.
- `updatedAt`: Timestamp when the record was last changed.
- `transcriptSummary`: Minimal transcript summary for list views, such as
  source item count, translation item count, final item count, and whether text
  is available.

### Optional

- `failureCategory`: Normalized category from failure classification.
- `lastLifecycleState`: Last observed lifecycle state before finalization.
- `targetLanguageLabel`: Display label for the selected target language.
- `sourceLanguageCode`: Source language metadata if it becomes available.
- `selectedInputDeviceId`: Browser-local selected microphone preference.
- `inputDeviceLabelSnapshot`: Non-authoritative label snapshot from the session.
- `reconnectAttemptCount`: Number of reconnect attempts observed during the
  session.
- `hasTranscript`: Convenience flag for list and export availability.
- `endedBy`: Normalized ending actor, such as `user`, `system`, or `failure`.

### Future

- `storageVersion`: Version marker for persisted record migrations.
- `appVersion`: Application version that created the record.
- `browserInfo`: Coarse browser/runtime metadata if explicitly needed.
- `tokenRefreshCount`: Count of token refreshes if token refresh is later
  implemented.
- `networkRecoveryCount`: Count of network recovery events if network reconnect
  is later implemented.
- `usageLogId`: Link to a future usage log record.
- `tags`: User or system tags if tagging is explicitly selected.
- `bookmarkCount`: Derived bookmark count if bookmarks are later implemented.
- `ownerUserId`: User ownership identifier if access control is selected.
- `workspaceId`: Workspace or organization identifier for a future multi-user
  scope.

## TranscriptItem Relationship

Session history should use an explicit one-to-many relationship:

```text
SessionRecord -> TranscriptItem[]
```

Draft transcript item shape:

```js
{
  id: "transcript-item-id",
  sessionId: "session-id",
  stream: "source",
  status: "final",
  text: "Recognized or translated text",
  sequence: 1,
  startedAt: 1234567890,
  finalizedAt: 1234567990,
  languageCode: "en"
}
```

Fields:

- `id`: Stable transcript item identifier.
- `sessionId`: Parent session record identifier.
- `stream`: `source` or `translation`.
- `status`: `partial` or `final`.
- `text`: Normalized transcript text.
- `sequence`: Monotonic order value from the transcript engine.
- `startedAt`: Frontend timestamp when the item was first observed.
- `finalizedAt`: Frontend timestamp when the item was finalized.
- `languageCode`: Optional language metadata if available.

Session history should not store only one large transcript string. A single
string would lose `sequence`, stream separation, partial/final status, and
timing metadata needed by saved-session rendering and TXT/SRT/VTT export.

## Session Lifecycle Mapping

### When Record Is Created

The first implementation may create a `SessionRecord` only after the live
session reaches `listening`. This avoids adding permission-denied or failed setup
attempts to translation history before the user actually starts translating.

Creating at `requesting-permission` or `connecting` remains possible later if
usage logging or setup diagnostics are explicitly selected, but those concerns
belong outside this capability's initial history boundary.

### When Record Is Updated

The record should be updated when session metadata changes or when the transcript
engine produces saveable transcript items:

- Target language metadata is known.
- The lifecycle state changes.
- A final transcript item is committed.
- A selected input device snapshot is available.
- Failure classification metadata becomes available.
- Reconnect attempt count changes, if already exposed by Connection Resilience.

Updates should preserve active-session transcript behavior. Saving a record must
not clear visible transcripts, request a new token, change device selection, or
start/stop a Gemini Live session.

### When Record Is Finalized

The record should be finalized when the session reaches a terminal or
manual-recovery state:

- `stopped` after successful user stop and cleanup.
- `error` after an unrecovered failure.
- `expired` when token/session expiration requires manual restart.

Finalization should set `endedAt`, compute `durationMs`, update `status`, set
`failureReason` when relevant, refresh `transcriptSummary`, and prevent further
mutation except delete or future explicit repair/migration actions.

When the user explicitly stops a Session, any visible pending transcript item is
committed as final before Session finalization. This preserves the last spoken
or translated text for saved history and TXT/SRT/VTT export when the Live API
has not emitted a final event yet.

### When Record Is Deleted

Deleting a record should remove the `SessionRecord` and its related
`TranscriptItem[]` from the selected repository adapter.

The implementation avoids deleting an active record. Delete behavior must not
affect current active-session state, microphone resources, Gemini Live
connections, export formatter code, device preferences, or language preferences.

Saved-session retranslation output deletion removes only a completed derived
`TranslationOutput` from the Session's translation command state. It must not
remove the source Session, canonical source transcript, request/execution audit
state, live-session primary output, or provider state.

## Repository Boundary

`SessionRepository` defines the storage-facing contract without selecting or
implementing a durable storage engine.

Suggested interface:

```js
{
  createSessionRecord(input),
  updateSessionRecord(id, patch),
  appendTranscriptItem(sessionId, item),
  finalizeSessionRecord(id, patch),
  listSessionRecords(),
  getSessionRecord(id),
  deleteSessionRecord(id)
}
```

Method intent:

- `createSessionRecord(input)`: Creates a new record draft or active record.
- `updateSessionRecord(id, patch)`: Applies metadata or lifecycle updates.
- `appendTranscriptItem(sessionId, item)`: Saves one normalized transcript item
  for a session.
- `finalizeSessionRecord(id, patch)`: Marks the session as terminal and stores
  final summary metadata.
- `listSessionRecords()`: Returns lightweight records suitable for history
  lists.
- `getSessionRecord(id)`: Returns one record and its transcript items.
- `deleteSessionRecord(id)`: Deletes one record and its transcript items.

The first implementation can use an in-memory adapter to validate the model and
lifecycle mapping. That adapter must not imply a commitment to `localStorage`,
IndexedDB, backend storage, file storage, SQLite, MariaDB, or any other storage
engine.

## UI Boundary

This capability defines only conceptual UI boundaries:

- History list: Show saved session records with minimal metadata such as target
  language, status, start/end time, duration, and transcript availability.
- Session detail: Show one saved session and its transcript items.
- Delete session: Remove a saved session and its transcript items through the
  repository boundary.
- Export saved session: Reuse existing transcript export behavior against saved
  transcript items.

This specification does not design a full UI, navigation structure, visual
layout, empty state copy, search, filters, or dashboard.

## Storage / Privacy Considerations

- Transcript content may contain sensitive information.
- Raw audio must not be stored.
- Retention policy is unresolved and must be decided before durable storage is
  selected.
- Delete semantics must be explicit for every storage adapter.
- Server-side storage will require access control before saved sessions can be
  read, deleted, or exported through backend endpoints.
- Raw SDK errors, stack traces, ephemeral tokens, `GEMINI_API_KEY`, and
  transcript content should not be written to logs unless a future privacy review
  explicitly approves a safe diagnostic policy.

## Suggested Implementation Slices

### Slice 1A: Session Domain Model

Status: Implemented.

Implementation files:

- `src/lib/sessionRecords.js`
- `tests/unit/sessionRecords.test.js`

This slice defines deterministic frontend-only utilities for `SessionRecord`
creation, patching, finalization, transcript item mapping, transcript summary,
and terminal status detection.

This slice does not implement:

- Repository interface.
- Memory adapter.
- UI.
- Persistence.
- Backend APIs.

### Slice 1B: Repository Interface + Memory Adapter

Status: Implemented.

Implementation files:

- `src/lib/sessionRepository.js`
- `tests/unit/sessionRepository.test.js`

This slice defines the `SessionRepository` method boundary and an in-memory
adapter using the existing session domain model utilities. It validates record
creation, transcript attachment, listing, detail retrieval, finalization, and
delete semantics without choosing durable storage.

This slice does not implement:

- Lifecycle wiring.
- UI.
- Persistence.
- `localStorage`.
- IndexedDB.
- Backend APIs.

### Slice 2: Lifecycle Mapping Into Current Session

Status: Implemented as Slice 2A.

Implementation files:

- `src/lib/sessionRecordLifecycle.js`
- `tests/unit/sessionRecordLifecycle.test.js`
- `src/main.jsx`

Map the current session lifecycle into the repository boundary. Create a record
after `listening`, update transcript items as final items become available, and
finalize on `stopped`, `error`, or `expired`.

Current Slice 2A behavior:

- Manual start creates a new active `SessionRecord` after the live session
  reaches `listening`.
- Controlled reconnect preserves the same active `SessionRecord`.
- Newly finalized source and translation transcript items are appended to the
  active record.
- Stop finalizes the active record as `stopped`.
- Token expiration finalizes the active record as `expired`.
- Unrecoverable errors and reconnect failure finalize the active record as
  `failed`.
- Finalization clears the active record reference.

Records currently exist only in the in-memory repository. Slice 2A does not
implement:

- History UI.
- Session detail UI.
- Saved-session export UI.
- Durable storage.
- `localStorage`.
- IndexedDB.
- Backend persistence.
- Backend APIs.

### Slice 3: History List UI

Status: Implemented.

Implementation files:

- `src/main.jsx`
- `src/styles.css`
- `tests/e2e/liveTranslate.spec.js`

Slice 3 adds a minimal read-only history list using lightweight
`SessionRecord` data from the current in-memory repository. The list shows only
finalized sessions, newest first, and excludes active records. It displays
target language, terminal status, start/end timing, duration, transcript
summary counts, and normalized failure reason for `failed` and `expired`
records.

Slice 3 does not implement:

- Session detail UI.
- Delete behavior.
- Saved-session export.
- Durable storage.
- `localStorage`.
- IndexedDB.
- Backend persistence.
- Backend APIs.
- Search, filters, bookmarks, or dashboards.

### Slice 4: Session Detail UI

Status: Implemented.

Implementation files:

- `src/main.jsx`
- `src/styles.css`
- `tests/e2e/liveTranslate.spec.js`

Slice 4 adds a read-only inline detail view for one finalized session. The
detail view reads through `getSessionRecord(id)` and displays session metadata,
normalized failure information when available, and saved final transcript items
separated into source and translation sections.

Slice 4 does not implement:

- Delete behavior.
- Saved-session export.
- Search, filters, bookmarks, or dashboards.
- Durable storage.
- `localStorage`.
- IndexedDB.
- Backend persistence.
- Backend APIs.
- Transcript editing.

### Slice 5: Saved Session Export

Status: Implemented.

Implementation files:

- `src/lib/sessionRecordExport.js`
- `tests/unit/sessionRecordExport.test.js`
- `src/main.jsx`
- `src/styles.css`
- `tests/e2e/liveTranslate.spec.js`

Slice 5 allows saved session detail views to export saved final transcript
items as TXT, SRT, or VTT by reusing the existing transcript export formatter.
TXT supports source, translation, and both streams. SRT and VTT support one
stream at a time. Saved subtitle timing uses the original session observation
timestamps with `SessionRecord.startedAt` as the session-relative time origin.

Slice 5 does not implement:

- Export controls in the history list.
- Backend export.
- Durable storage.
- `localStorage`.
- IndexedDB.
- Backend persistence.
- Backend APIs.
- Delete behavior.
- Search, filters, bookmarks, or dashboards.

### Slice 6: Storage Engine Decision

Choose durable storage only after retention, privacy, delete semantics, and
access-control implications are decided.

## Testing Strategy

Automated tests for this capability should use deterministic helpers and must
not call the real Gemini API.

- Model utility tests for `SessionRecord` creation, patching, status handling,
  duration calculation, and transcript summaries.
- Repository tests for create, update, append transcript item, finalize, list,
  detail, and delete behavior.
- Lifecycle mapping tests for creating records after `listening`, finalizing on
  `stopped`, `error`, and `expired`, and avoiding records for permission-denied
  setup failures if that policy is selected.
- UI tests later for history list, session detail, delete, and saved-session
  export once UI slices are implemented.
- No real Gemini API validation is required or allowed by default.

## Risks

- Search, filter, and bookmark requests can expand this beyond session history.
- Usage analytics or admin review can turn the capability into an analytics or
  dashboard project.
- Login, database, or access-control work can overtake the model and repository
  boundary before storage requirements are ready.
- Backend export endpoints can be added prematurely even though frontend export
  may be sufficient for local history.
- Raw SDK diagnostic logging can expose sensitive errors, transcript content, or
  implementation details.
- Audio pipeline changes can leak into history work if transcript timing quality
  is treated as an audio-processing problem.

## Acceptance Criteria

- `SessionRecord` model is documented.
- Transcript relationship is documented.
- Repository boundary is documented.
- Storage decision is deferred.
- Capability boundary is clear.
- No production code is changed by this specification.
