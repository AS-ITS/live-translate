# Domain Model

## 1. Purpose

This document defines the target domain model for the Session-oriented
Real-time Multilingual Translation Platform.

It records the Phase 2B target contracts and distinguishes them from the current
Phase 2A implementation. Phase 2B-1 is documentation and contract definition
only. Phase 2B-2 may add skeletons, ports, compatibility adapters, and
read-model wrappers. Phase 2C may add saved transcript re-translation,
multi-output UI, retry, cancel, delete, provider selection, and output version
UI.

Related architecture docs:

- [Architecture Overview](architecture-overview.md)
- [Phase 2B Application Foundation](phase2b-application-foundation.md)
- [Session Records Architecture](session-records-architecture.md)
- [Session Records & Translation History](../features/session-records-history.md)
- [Transcript Export](../features/transcript-export.md)

## 2. Current Implementation

Current production code remains a simplified single-output model:

- `SessionRecord` is the current memory repository storage shape.
- Each record has one `targetLanguageCode`.
- Source and translated transcript items are stream-based `TranscriptItem`
  records attached to the same session record.
- The repository is memory-only.
- `main.jsx` owns application orchestration.
- `LiveTranslateSession` is Gemini/browser-specific and owns token use,
  WebSocket/session setup, microphone capture, audio graph behavior, and
  playback.

`SessionRecord` is therefore a current implementation and compatibility shape,
not the canonical Phase 2B target aggregate.

## 3. Phase 2B Target Overview

Phase 2B introduces an explicit Application Layer and separates canonical
domain aggregates from read models and infrastructure adapters.

Dependency direction:

```text
React UI / REST API / Worker
            |
            v
Application Services
            |
            v
Domain Model and Policies
            |
            v
Ports
            |
            v
Infrastructure Adapters
```

React components must not directly own repository writes, session finalization,
translation execution, or export orchestration. Existing helpers may initially
be wrapped by application services instead of moved in bulk.

## 4. Aggregate Boundaries

The target model uses two aggregates:

```text
Session Aggregate
├── Session
└── SourceTranscript

Translation Aggregate
├── TranslationRequest
├── TranslationExecutions
└── TranslationOutput
```

Long Meeting support adds a separate aggregate boundary for long-running
meeting capture:

```text
Meeting Aggregate
├── Meeting
└── MeetingSegment 1..n
```

The aggregates use identity references:

```text
TranslationRequest.sessionId
TranslationRequest.sourceTranscriptRevisionId
```

Rules:

- Session does not directly hold the full TranslationRequest collection.
- Translation lifecycle updates do not require modifying the Session aggregate.
- Session detail is an Application Read Model composed from Session and
  Translation data.
- SourceTranscript is the Session aggregate's canonical source.
- TranslationOutput must point to a fixed `sourceTranscriptRevisionId`.
- Meeting lifecycle updates do not require modifying Translation aggregate
  state.
- A MeetingSegment may reference a Live Session by identity. The Live Session
  remains the owner of the browser-to-Gemini attempt and audio flow.

## 5. Domain Entities

Canonical domain entities:

- `Session`
- `SourceTranscript`
- `TranslationRequest`
- `TranslationExecution`
- `TranslationOutput`
- `TranscriptItem`
- `Meeting`
- `MeetingSegment`

Application DTOs and read models are not domain entities.

## 5A. Meeting

`Meeting` represents one long-running meeting container. It can span multiple
Live Session attempts through ordered `MeetingSegment` records.

Fields:

- `id`
- `status`: `created`, `active`, `completed`, `interrupted`, or `failed`
- `startedAt`
- `endedAt`
- `createdAt`
- `updatedAt`
- `failureInfo`, optional

Rules:

- A Meeting owns the ordered Segment collection by `meetingId`.
- Meeting completion does not create or mutate TranslationOutput records.
- Meeting failure does not rewrite completed Segment state.
- Interrupted Meetings can be reactivated; completed and failed Meetings are
  terminal.

## 5B. MeetingSegment

`MeetingSegment` represents one independently persisted and recoverable slice of
a long Meeting.

Fields:

- `id`
- `meetingId`
- `sequence`
- `status`: `created`, `active`, `completed`, `interrupted`, or `failed`
- `startedAt`
- `endedAt`
- `liveSessionId`, optional
- `checkpoint`, optional
- `errorInfo`, optional
- `createdAt`
- `updatedAt`

Rules:

- Segment sequence is scoped to a Meeting and must not collide within the same
  Meeting.
- A Segment may independently transition through active, completed,
  interrupted, or failed states.
- Checkpoint and error metadata are retained on the Segment, not on the Live
  Session.
- Existing non-Meeting Live Session records remain valid with no `meetingId` or
  `segmentId`.

Checkpoint metadata stores only confirmed durable transcript or translation
chunks:

- `idempotencyKey`
- `durableChunks[]`
- `pendingPartial`: always `null` in durable storage
- `updatedAt`

Each durable chunk includes `meetingId`, `segmentId`, `stream`, `sequence`,
`text`, `timestamp`, and an item-level `idempotencyKey`. Duplicate chunk keys
with identical content are idempotent; duplicate keys or duplicate
`stream + sequence` values with different content are conflicts. Pending
partial text remains browser-local until it becomes confirmed final transcript
content.

## 6. Session

`Session` represents one user source-capture work unit.

Suggested fields:

- `id`
- `startedAt`
- `endedAt`
- `status`
- `sourceTranscriptId`
- `createdAt`
- `updatedAt`
- lifecycle metadata
- failure metadata, optional

Rules:

- Manual Start creates a new Session.
- Reconnect does not create a new Session.
- Re-translation from a saved SourceTranscript does not create a new Session.
- A new raw audio input work item creates a new Session.
- Translation execution failure does not affect Session completion status.

## 7. SourceTranscript

`SourceTranscript` is the canonical textual representation of the original
speech input within the Session aggregate.

Suggested fields:

- `id`
- `sessionId`
- `revisionId`
- `languageHints`, optional
- `transcriptItems`
- `createdAt`
- `finalizedAt`
- `status`

Rules:

- SourceTranscript can contain multiple `TranscriptItem` records.
- Each item preserves `sequence`, timing, and `status`.
- SourceTranscript should not be collapsed into one large string.
- SourceTranscript should not store raw audio unless approved later.
- A TranslationOutput always references the fixed source transcript revision it
  was derived from.

## 8. Translation Model

The target translation model is:

```text
TranslationRequest
    |
    +-- TranslationExecution 1..n
    |
    +-- TranslationOutput 0..1 successful result
```

### TranslationRequest

`TranslationRequest` represents one product intent to translate a specific
SourceTranscript revision into a target output.

Suggested fields:

- `id`
- `sessionId`
- `sourceTranscriptRevisionId`
- `targetLanguageCode`
- `providerSelection`, optional
- `status`
- `createdAt`
- `updatedAt`

Rules:

- Retry does not create a new TranslationRequest.
- Retry creates a new TranslationExecution under the original request.
- A request can have zero or one successful TranslationOutput.
- Request status belongs to the Translation aggregate and is persisted.

### TranslationExecution

`TranslationExecution` represents one provider execution attempt for a
TranslationRequest.

Suggested fields:

- `id`
- `translationRequestId`
- `provider`
- `model`
- `status`
- `startedAt`
- `endedAt`
- `failureReason`, optional
- provider metadata, optional

Rules:

- Each retry is a new TranslationExecution.
- Execution status belongs to the Translation aggregate and is persisted.
- Execution failure does not change Session status.

### TranslationOutput

`TranslationOutput` is successful derived data created from a
TranslationRequest.

Suggested fields:

- `id`
- `translationRequestId`
- `sessionId`
- `sourceTranscriptRevisionId`
- `targetLanguageCode`
- `targetLanguageLabel`, optional
- `transcriptItems`
- `provider`, optional
- `model`, optional
- `createdAt`
- `completedAt`

Rules:

- TranslationOutput is derived data.
- TranslationOutput is created only after successful execution.
- TranslationOutput availability is persisted domain state.
- TranslationOutput can be listed and exported independently in Phase 2C.
- Delete behavior is Phase 2C, not Phase 2B-1.

## 9. TranscriptItem

`TranscriptItem` is the shared transcript segment shape used by SourceTranscript
and TranslationOutput.

Suggested fields:

- `id`
- `parentId`
- `parentType`: `source_transcript` or `translation_output`
- `stream`: `source` or `translation`
- `status`: `partial` or `final`
- `text`
- `sequence`
- `startedAt`
- `finalizedAt`
- `languageCode`, optional

Current implementation note:

- Existing code uses `sessionId` plus `stream` to distinguish source and
  translation items.
- Phase 2B compatibility mapping should project this legacy shape into the
  target read-model contracts.

## 10. Repository Boundaries

Phase 2B adopts two repository ports:

```text
SessionRepository
TranslationRepository
```

Long Meeting support adds:

```text
MeetingRepository
```

Responsibilities:

- `SessionRepository` manages the Session aggregate and SourceTranscript.
- `TranslationRepository` manages the Translation aggregate.
- `MeetingRepository` manages the Meeting aggregate and its ordered
  MeetingSegments.
- ExportArtifact is derived result data and does not need a repository.

Not introduced in Phase 2B:

```text
SourceTranscriptRepository
TranslationRequestRepository
TranslationExecutionRepository
TranslationOutputRepository
ExportArtifactRepository
MeetingSegmentRepository
```

Compatibility Adapter placement:

- Place compatibility mapping in repository implementation or read-model mapper.
- Do not place the Compatibility Adapter in Application Service.
- Application Service must not depend on the legacy `SessionRecord` storage
  shape.

## 11. Provider Ports

Phase 2B-1 defines these provider ports:

```text
LiveSpeechTranslationPort
SavedTranscriptTranslationPort
```

Rules:

- Gemini token handling, WebSocket/session setup, audio graph, `AudioContext`,
  and browser permissions are infrastructure.
- `LiveTranslateSession` may later become a `LiveSpeechTranslationPort`
  infrastructure adapter.
- Saved transcript translation must not be forced through realtime microphone or
  audio lifecycle interfaces.
- The two ports may share normalized error types, provider metadata, and
  transcript item shapes, but they must not share an unsuitable lifecycle
  interface.

Deferred:

```text
SpeechSynthesisPort
```

## 12. Read Models

Application DTOs and read models:

- `SessionHistoryListItem`
- `SessionDetailDTO`
- `TranslationOutputSummaryDTO`
- `TranslationOutputDetailDTO`
- `TranslationRequestDTO`
- `TranslationExecutionDTO`

Rules:

- React components should consume DTOs/read models, not assemble domain
  aggregates directly.
- `SessionDetailDTO` may compose Session aggregate data and Translation
  aggregate data.
- Legacy `SessionRecord` data must be projected through a Compatibility Adapter
  into the same read-model contracts.
- Phase 2B-2 must preserve the current UI's single-output display while adding
  target read-model boundaries.

## 13. Application Services

Phase 2B-1 defines contracts only. Phase 2B-2 may implement skeletons and
wrappers.

`SessionApplicationService`:

- `createSession`
- `startLiveSession`
- `reconnectSession`
- `stopSession`
- `completeSession`
- `interruptSession`
- `failSession`
- `getSessionDetail`
- `listSessions`

`TranslationApplicationService`:

- `requestTranslation`
- `executeTranslation`
- `retryTranslation`
- `cancelTranslation`
- `getTranslationRequest`
- `listTranslationOutputs`
- `deleteTranslationOutput`

`ExportApplicationService`:

- `exportSourceTranscript`
- `exportTranslationOutput`
- `exportCombinedSessionView`

Use-case phase ownership is defined in
[Phase 2B Application Foundation](phase2b-application-foundation.md).

## 14. Domain Events

Phase 2B uses lightweight event contracts only:

- Not Event Sourcing.
- No message broker.
- No replay.
- No persisted event history.
- No outbox implementation.
- Phase 2B-1 defines event contracts only.
- Phase 2B-2 may use synchronous in-memory dispatch only if a handler is needed.

Minimum Phase 2B-1 events:

- `SessionCreated`
- `SessionCompleted`
- `SessionFailed`
- `SourceTranscriptFinalized`
- `TranslationRequested`
- `TranslationExecutionStarted`
- `TranslationExecutionFailed`
- `TranslationOutputCreated`

Event categories:

- Domain Event: fact that aggregate state has already changed.
- Application Event: use-case coordination milestone.
- Infrastructure Event: browser, WebSocket, Gemini SDK, audio, or device runtime
  signal.

Do not define these as Domain Events:

- transcript partial updates
- audio chunks
- Gemini SDK packets
- WebSocket close packets
- reconnect timer ticks
- microphone permission UI events
- browser suspend/resume events

## 15. Event Envelope

Required envelope fields:

```json
{
  "eventId": "evt_123",
  "eventType": "TranslationOutputCreated",
  "aggregateType": "TranslationRequest",
  "aggregateId": "tr_123",
  "sessionId": "sess_123",
  "occurredAt": "2026-07-13T12:00:00.000Z",
  "schemaVersion": 1,
  "payload": {}
}
```

Required:

- `eventId`
- `eventType`
- `aggregateType`
- `aggregateId`
- `occurredAt`
- `schemaVersion`
- `payload`

Required when applicable:

- `sessionId`

Deferred:

- `correlationId`
- `causationId`
- `aggregateVersion`
- `actor`
- `tenantId`
- `traceId`

Provider metadata belongs in relevant event payloads or aggregate data, not in
every event envelope.

## 16. State Ownership

| State | Owner | Persisted |
| ----- | ----- | --------- |
| Session status | Domain | Yes |
| Live connection status | Application / Infrastructure | No |
| Microphone status | Infrastructure | No |
| Source transcript status | Domain | Yes |
| Translation request status | Domain | Yes |
| Translation execution status | Domain | Yes |
| Translation output availability | Domain | Yes |
| Export status | Application runtime state | No |
| UI loading state | UI only | No |

Rules:

- Provider socket close does not directly make Session failed.
- Microphone disconnect does not directly make Session failed.
- Browser suspend does not directly make Session failed.
- The Application Layer must classify runtime failures before deciding whether
  they become domain lifecycle transitions.
- Translation execution failure does not affect Session status.

## 17. Current to Future Mapping

Migration direction:

1. Keep current `SessionRecord` compatibility.
2. Add Application Layer contracts and read-model wrappers.
3. Keep `SessionRepository` current behavior while adding compatibility mapping.
4. Introduce `TranslationRepository` for the Translation aggregate in Phase
   2B-2.
5. Map current source stream to SourceTranscript.
6. Map current translation stream to the single current TranslationOutput view.
7. Add Phase 2C re-translation, multiple outputs, retry/cancel/delete, provider
   selection, and output version UI.
8. Evaluate durable storage last.

## 18. Terminology

Canonical target terms:

- `Session`
- `SourceTranscript`
- `TranslationRequest`
- `TranslationExecution`
- `TranslationOutput`
- `TranscriptItem`
- `Application Layer`
- `Compatibility Adapter`

`TranslationJob` is not a canonical domain entity. It may appear only in current
proposal history, legacy naming, or transitional compatibility aliases and must
be labelled as non-target terminology when used.

## 19. Non-Goals

This domain model does not include:

- Durable database selection
- Event outbox
- Broker
- Event replay
- Raw audio storage
- Text-to-speech regeneration
- Billing
- Multi-tenancy
- Production deployment concerns
- AI summary
- Speaker diarization
- Search
- Bookmarks
- Diagnostics dashboard
- Access control
