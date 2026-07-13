# Session Records Architecture

## Purpose

This document describes the Domain Architecture for Session Records.

It does not discuss:

- UI.
- Storage engine.
- Backend API.
- Access control.

It only discusses:

- Domain model.
- Ownership.
- Repository boundary.
- Lifecycle.
- Future extension.

Session Records should provide a stable domain boundary for turning a completed
live translation session into a read-only history record without changing the
Gemini Live session flow, the transcript engine, reconnect behavior, token
refresh behavior, or storage infrastructure.

## Domain Model

```mermaid
flowchart TD
  LiveSession[Live Session]
  TranscriptEngine[Transcript Engine]
  SessionRecord[Session Record]
  SessionRepository[Session Repository]
  HistoryConsumer[History Consumer]
  HistoryUI[History UI]
  Export[Export]

  LiveSession --> TranscriptEngine
  TranscriptEngine --> SessionRecord
  SessionRecord --> SessionRepository
  SessionRepository --> HistoryConsumer
  HistoryConsumer --> HistoryUI
  HistoryConsumer --> Export
```

The domain flow is intentionally one-way:

- A live session emits lifecycle and transcript-domain events.
- The transcript engine owns normalized transcript items.
- The session record captures session metadata and references transcript items.
- The repository abstracts persistence.
- History consumers read finalized records without mutating live-session or
  transcript-engine state.

## Ownership

### LiveSession

Responsible for:

- Creating the active session lifecycle.
- Updating lifecycle state during the live session.
- Emitting or exposing enough lifecycle information for record updates.
- Finalizing the session record when the live session reaches a terminal state.

LiveSession must not depend on a concrete storage engine. It should talk only to
the `SessionRepository` boundary or to a narrow session-record coordinator that
uses that boundary.

### Transcript Engine

Responsible for:

- Creating and updating `TranscriptItem` domain objects.
- Maintaining source and translation stream separation.
- Maintaining `partial` and `final` transcript status.
- Preserving transcript ordering through `sequence`.
- Providing timing fields when available.

The transcript engine is the source of transcript-domain truth. It must not know
where history is stored.

### Repository

Responsible for:

- Persistence abstraction.
- Creating, updating, finalizing, listing, reading, and deleting session records.
- Attaching transcript items to session records.
- Hiding storage-specific behavior behind a stable interface.

The repository must not depend on UI components, routing, rendering, or export
controls.

### History UI

Responsible for:

- Read-only consumption of finalized session records.
- Requesting list/detail/delete/export actions through domain-facing boundaries.
- Rendering saved session metadata and transcript items.

History UI must not mutate transcript engine state or reopen finalized records
for editing.

## Domain Objects

### SessionRecord

`SessionRecord` represents one recorded live translation session.

Core Domain fields:

- `id`
- `startedAt`
- `endedAt`
- `durationMs`
- `targetLanguageCode`
- `status`
- `failureReason`
- `createdAt`
- `updatedAt`
- `transcriptSummary`

Future Extension fields:

- `failureCategory`
- `lastLifecycleState`
- `targetLanguageLabel`
- `sourceLanguageCode`
- `selectedInputDeviceId`
- `inputDeviceLabelSnapshot`
- `reconnectAttemptCount`
- `hasTranscript`
- `endedBy`
- `storageVersion`
- `appVersion`
- `browserInfo`
- `tokenRefreshCount`
- `networkRecoveryCount`
- `usageLogId`
- `tags`
- `bookmarkCount`
- `ownerUserId`
- `workspaceId`

### TranscriptItem

`TranscriptItem` represents one normalized transcript segment created by the
transcript engine and associated with a session record.

Core Domain fields:

- `id`
- `sessionId`
- `stream`: `source` or `translation`
- `status`: `partial` or `final`
- `text`
- `sequence`
- `startedAt`
- `finalizedAt`
- `languageCode`

Future Extension fields:

- Provider segment identifier, if the Gemini Live event contract exposes one.
- Provider timestamp, if reliable media-aligned timing becomes available.
- Confidence or quality metadata, if explicitly selected later.

Transcript history should store transcript items, not a single combined
transcript string. `TranscriptItem` preserves sequence, stream, status, and
timing, which are required for reliable history detail rendering and export.

### Repository

`SessionRepository` is the persistence boundary for session records and related
transcript items.

Current implementation:

- `src/lib/sessionRepository.js` defines the method boundary.
- `createMemorySessionRepository()` provides an in-memory adapter for Slice 1B
  validation.
- The memory adapter is not durable storage and does not select `localStorage`,
  IndexedDB, backend storage, a database, or a file format.

Core Domain responsibilities:

- Create session records.
- Update session records.
- Append transcript items.
- Finalize session records.
- List session records.
- Read one session record with transcript items.
- Delete one session record with transcript items.

Future Extension responsibilities:

- Swap storage adapters.
- Support migrations when durable storage is selected.
- Apply retention rules after retention policy is approved.
- Enforce adapter-level delete semantics after storage is selected.

## Repository Boundary

`SessionRepository` interface:

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

Method ownership:

- `createSessionRecord(input)`: Create a new session record after the chosen
  lifecycle creation point.
- `updateSessionRecord(id, patch)`: Apply non-terminal metadata and lifecycle
  updates.
- `appendTranscriptItem(sessionId, item)`: Attach a normalized transcript item
  to the record.
- `finalizeSessionRecord(id, patch)`: Move a record into a terminal state and
  store final summary metadata.
- `listSessionRecords()`: Return lightweight read models for history consumers.
- `getSessionRecord(id)`: Return one record and its transcript items.
- `deleteSessionRecord(id)`: Delete one record and its transcript items.

This interface is the required boundary for repository adapters. Slice 1B adds
an in-memory adapter for deterministic validation, but the architecture still
does not choose a durable storage engine.

## Lifecycle Ownership

```text
create -> active -> update -> finalize -> read -> delete
```

### Create

Owner: LiveSession lifecycle mapping.

The first implementation should create a record after the live session reaches
`listening`. This avoids adding permission-denied or setup-failed attempts to
translation history.

### Active

Owner: LiveSession lifecycle mapping.

The record is considered active while the live session is still producing
transcript items or lifecycle updates. Active records should not be read as
final history and should not be deleted by history consumers.

### Update

Owners: LiveSession lifecycle mapping and Transcript Engine.

LiveSession provides lifecycle metadata such as status, failure reason, and
timestamps. Transcript Engine provides normalized transcript items. A coordinator
or adapter should map those events into repository calls.

### Finalize

Owner: LiveSession lifecycle mapping.

Finalization happens when the session reaches a terminal or manual-recovery
state such as `stopped`, `error`, or `expired`. Finalization sets `endedAt`,
computes `durationMs`, stores final status/failure metadata, and closes the
record for editing.

### Read

Owner: History consumers.

History consumers read finalized records through `listSessionRecords()` and
`getSessionRecord(id)`. Read operations must not mutate live-session,
transcript-engine, or repository state beyond any storage-internal cache that a
future adapter may own.

### Delete

Owner: History consumer through repository boundary.

Delete removes a finalized record and its transcript items through
`deleteSessionRecord(id)`. Delete must not touch the current live session,
Gemini Live connection, transcript engine state, audio resources, or token flow.

## Dependency Rules

- Transcript Engine must not depend on Repository.
- Repository must not depend on UI.
- History UI must not modify Transcript Engine.
- Connection Resilience must not directly operate Repository.
- LiveSession must not depend on a concrete repository adapter.
- SessionRepository adapters must not call Gemini Live APIs.
- Export must consume transcript items and must not mutate session records.
- Storage adapters must not reinterpret raw SDK events; they store domain
  objects only.

Connection Resilience may produce failure or retry metadata that Session Records
captures through lifecycle mapping. It must not create, update, finalize, or
delete records directly.

## Future Storage

```mermaid
flowchart TD
  SessionRepository[SessionRepository]
  MemoryRepository[MemoryRepository]
  IndexedDBRepository[IndexedDBRepository]
  BackendRepository[BackendRepository]

  SessionRepository --> MemoryRepository
  SessionRepository --> IndexedDBRepository
  SessionRepository --> BackendRepository
```

The abstraction and a non-durable memory adapter are defined now.

Future adapters may include:

- `MemoryRepository` for model and repository-boundary validation.
- `IndexedDBRepository` for browser-local durable history.
- `BackendRepository` for server-owned history after access control, retention,
  and privacy rules are approved.

No current architecture decision binds Session Records to `localStorage`,
IndexedDB, backend persistence, a database, or a file format. The memory adapter
must remain replaceable and must not leak into UI, lifecycle wiring, or storage
selection decisions.

## Architecture Decisions

### ADR-001: Session Repository Pattern

Status: Accepted.

Reason: Use a repository boundary to avoid binding Session Records to
`localStorage`, IndexedDB, or backend storage. This keeps the domain model stable
while storage, privacy, retention, and access-control requirements remain
unresolved.

### ADR-002: TranscriptItem Is the Source of Truth

Status: Accepted.

Reason: Store normalized `TranscriptItem` objects instead of one combined
transcript string. This preserves `sequence`, `stream`, `status`, and timing
metadata for history detail views and transcript export.

### ADR-003: History Is Read-Only

Status: Accepted.

Reason: After session finalization, transcript history is review-only.
Disallowing transcript editing keeps the first history capability focused and
prevents unclear ownership between saved records, transcript engine state, and
future editing workflows.

## Out of Scope

- Search.
- Bookmarks.
- Usage metrics.
- Diagnostics.
- AI summary.
- Audio storage.
- Token refresh.
- Access control.

## Acceptance Criteria

- Domain ownership is clear.
- Repository boundary is clear.
- Lifecycle ownership is clear.
- Future storage is replaceable.
- Architecture does not depend on a specific storage engine.
- Production code is not changed by this architecture document.
