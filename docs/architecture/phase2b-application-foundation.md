# Phase 2B Application Foundation

> 範圍註記：本文記錄 Phase 2B Session／翻譯歷史設計與當時的實作狀態，不是 v1.0.0 Meeting 錄製流程。現行 Meeting 內容由 Host OPFS／IndexedDB 保存；Supabase 僅保存 metadata、字典、帳號、授權與必要協調資料；Viewer 字幕由 WebRTC DataChannel 傳送。現行契約見[架構總覽](architecture-overview.md)。

## 1. Purpose

This document defines the Phase 2B Architecture Foundation for the
Session-oriented Real-time Multilingual Translation Platform.

Phase 2B-1 established contracts, terminology, boundaries, and deferred scope.
Phase 2B-2 implementation is now being delivered incrementally, beginning with
the Session Application Service boundary.

## 2. Current Implementation Constraints

Current implementation:

- Simplified single-output model.
- `SessionRecord` memory repository storage shape.
- Session-level `targetLanguageCode`.
- Stream-based source and translation `TranscriptItem` records.
- Memory repository only.
- `main.jsx` application orchestration.
- `LiveTranslateSession` Gemini/browser-specific implementation.

Constraints:

- Do not move existing files in bulk.
- Do not change the core Gemini Live session flow in Phase 2B-1.
- Do not expose `GEMINI_API_KEY` or ephemeral tokens.
- Do not introduce durable storage, databases, brokers, outbox, or replay.
- Keep current single-output UI behavior through the Phase 2B-2 transition.

## 3. Phase Boundaries

### Phase 2B-1: Architecture Foundation

Scope:

- Update architecture and specification documents.
- Define Application Layer contracts.
- Define aggregate boundaries.
- Define repository and provider ports.
- Define read-model contracts.
- Define lightweight domain event contracts.
- Define Compatibility Adapter placement.

No production implementation is included.

### Phase 2B-2: Foundation Implementation

Scope:

- Add application service skeletons.
- Add repository and provider port skeletons.
- Add Compatibility Adapter implementation or read-model mappers.
- Add read-model wrappers.
- Preserve existing helpers by wrapping them where practical.
- Preserve current single-output UI behavior.

Current implementation slice:

- `SessionApplicationService` wraps Session command persistence and Session
  read-model access.
- Existing repository and read-model adapters remain the compatibility
  boundary for memory and file-backed storage.
- Session HTTP list/create/detail/update routes use the application service
  when composed.

### Phase 2C: Product Capability Implementation

Scope:

- Saved transcript re-translation.
- Multiple outputs.
- Retry.
- Cancel.
- Delete.
- Provider selection.
- Output version UI.

## 4. Dependency Direction

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

Rules:

- React components must not directly own repository writes.
- React components must not directly own session finalization.
- React components must not directly own translation execution.
- React components must not directly own export orchestration.
- Application Services must not depend on the legacy `SessionRecord` storage
  shape.
- Compatibility mapping belongs in repository implementation or read-model
  mapper, not in Application Service.

## 5. Application Service Responsibilities

Phase markers:

- `Phase 2B-1 contract only`: documented now, not implemented now.
- `Phase 2B-2 implementation`: target skeleton/wrapper implementation.
- `Phase 2C`: product behavior implementation.
- `Deferred`: intentionally out of current foundation scope.

### SessionApplicationService

| Use case | Phase |
| -------- | ----- |
| `createSession` | Phase 2B-2 implementation |
| `startLiveSession` | Phase 2B-2 implementation |
| `reconnectSession` | Phase 2B-2 implementation |
| `stopSession` | Phase 2B-2 implementation |
| `completeSession` | Phase 2B-2 implementation |
| `interruptSession` | Phase 2B-1 contract only |
| `failSession` | Phase 2B-2 implementation |
| `getSessionDetail` | Phase 2B-2 implementation |
| `listSessions` | Phase 2B-2 implementation |

Notes:

- `interruptSession` remains contract-only until interruption semantics are
  selected.
- Runtime connection failures must be classified before they become domain
  lifecycle transitions.

### TranslationApplicationService

| Use case | Phase |
| -------- | ----- |
| `requestTranslation` | Phase 2B-2 implementation |
| `executeTranslation` | Phase 2B-2 implementation |
| `retryTranslation` | Phase 2C |
| `cancelTranslation` | Phase 2C |
| `getTranslationRequest` | Phase 2B-2 implementation |
| `listTranslationOutputs` | Phase 2B-2 implementation |
| `deleteTranslationOutput` | Saved retranslation API/UI implemented; ApplicationService wrapper Phase 2C |

Notes:

- Phase 2B-2 may wrap the current single live translation as one request,
  execution, and output projection.
- Retry creates a new TranslationExecution, not a new TranslationRequest.

### ExportApplicationService

| Use case | Phase |
| -------- | ----- |
| `exportSourceTranscript` | Phase 2B-2 implementation |
| `exportTranslationOutput` | Phase 2B-2 implementation |
| `exportCombinedSessionView` | Phase 2B-2 implementation |

Notes:

- ExportArtifact is derived result data and does not need a repository in Phase
  2B.
- Export status is application runtime state and is not persisted.

## 6. Aggregate Boundaries

```text
Session Aggregate
├── Session
└── SourceTranscript

Translation Aggregate
├── TranslationRequest
├── TranslationExecutions
└── TranslationOutput
```

Identity references:

```text
TranslationRequest.sessionId
TranslationRequest.sourceTranscriptRevisionId
```

Rules:

- Session does not directly hold a complete TranslationRequest collection.
- Translation lifecycle updates do not require modifying the Session aggregate.
- SourceTranscript is the Session aggregate's canonical source.
- TranslationOutput must point to a fixed `sourceTranscriptRevisionId`.
- Session detail is an Application Read Model composed from Session and
  Translation data.

## 7. Repository Ports

Phase 2B repository ports:

```text
SessionRepository
TranslationRepository
```

Responsibilities:

- `SessionRepository` manages the Session aggregate and SourceTranscript.
- `TranslationRepository` manages the Translation aggregate.
- `ExportArtifact` is derived result data and does not need a repository.

Not created in Phase 2B:

```text
SourceTranscriptRepository
TranslationRequestRepository
TranslationExecutionRepository
TranslationOutputRepository
ExportArtifactRepository
```

Compatibility Adapter placement:

- Repository implementation, or
- Read-model mapper.

Not allowed:

- Compatibility Adapter inside Application Service.
- Application Service depending on the legacy `SessionRecord` shape.

## 8. Provider Ports

Phase 2B-1 defines:

```text
LiveSpeechTranslationPort
SavedTranscriptTranslationPort
```

Rules:

- Gemini token handling is infrastructure.
- WebSocket/session setup is infrastructure.
- Audio graph and `AudioContext` are infrastructure.
- Browser permissions are infrastructure.
- `LiveTranslateSession` may become a `LiveSpeechTranslationPort`
  infrastructure adapter.
- Saved transcript translation must not be forced through realtime
  microphone/audio interfaces.
- The two ports may share normalized error types, provider metadata, and
  transcript item shapes.
- The two ports must not share an unsuitable lifecycle interface.

Deferred:

```text
SpeechSynthesisPort
```

Reason: text-to-speech regeneration requires explicit product and provider
decisions and is not necessary for Phase 2B foundation contracts.

## 9. Translation Model

Formal model:

```text
TranslationRequest
    |
    +-- TranslationExecution 1..n
    |
    +-- TranslationOutput 0..1 successful result
```

Semantics:

- TranslationRequest represents one product intent.
- TranslationExecution represents one provider execution attempt.
- Retry does not create a new TranslationRequest.
- Retry creates a new TranslationExecution under the original request.
- TranslationOutput is created only after success.
- TranslationOutput is derived data.
- Translation failure does not affect Session completion status.
- `TranslationJob` is not a canonical domain term. It may appear only as legacy
  naming or a transitional compatibility alias and must be labelled that way.

## 10. Read-Model Contracts

Domain entities:

- `Session`
- `SourceTranscript`
- `TranslationRequest`
- `TranslationExecution`
- `TranslationOutput`
- `TranscriptItem`

Application DTOs / Read Models:

- `SessionHistoryListItem`
- `SessionDetailDTO`
- `TranslationOutputSummaryDTO`
- `TranslationOutputDetailDTO`
- `TranslationRequestDTO`
- `TranslationExecutionDTO`

Rules:

- React components should consume read models, not assemble domain aggregates.
- `SessionDetailDTO` may compose Session Aggregate and Translation Aggregate
  data.
- Legacy `SessionRecord` data must be projected through a Compatibility Adapter
  into the same read-model contracts.
- Phase 2B-2 must keep the current UI single-output display working.

## 11. Compatibility Adapter Placement

The Compatibility Adapter converts current `SessionRecord` storage and
stream-based `TranscriptItem` data into target read-model contracts.

Allowed placements:

- Repository implementation.
- Read-model mapper.

Disallowed placement:

- Application Service.
- React component.

Reason:

- Application Services should depend on domain and port contracts, not legacy
  persistence details.
- React components should render DTOs/read models and avoid aggregate assembly.

## 12. Domain Event Definitions

Phase 2B uses lightweight event contracts:

- Not Event Sourcing.
- No message broker.
- No replay.
- No persisted event history.
- No outbox implementation.
- Phase 2B-1 defines contracts only.
- Phase 2B-2 may use synchronous in-memory dispatch only if a handler is needed.

Minimum Phase 2B-1 events:

| Event | Category | Aggregate | Meaning |
| ----- | -------- | --------- | ------- |
| `SessionCreated` | Domain Event | Session | A Session aggregate was created. |
| `SessionCompleted` | Domain Event | Session | A Session reached completed state. |
| `SessionFailed` | Domain Event | Session | A classified failure changed Session state to failed. |
| `SourceTranscriptFinalized` | Domain Event | Session | SourceTranscript reached finalized state. |
| `TranslationRequested` | Domain Event | TranslationRequest | A TranslationRequest was created. |
| `TranslationExecutionStarted` | Domain Event | TranslationRequest | A TranslationExecution attempt started. |
| `TranslationExecutionFailed` | Domain Event | TranslationRequest | A TranslationExecution attempt failed. |
| `TranslationOutputCreated` | Domain Event | TranslationRequest | A successful TranslationOutput was created. |

Event categories:

- Domain Event: aggregate state has already changed.
- Application Event: use-case coordination milestone.
- Infrastructure Event: browser, WebSocket, Gemini SDK, audio, or device runtime
  signal.

Do not define as Domain Events:

- transcript partial updates
- audio chunks
- Gemini SDK packets
- WebSocket close packets
- reconnect timer ticks
- microphone permission UI events
- browser suspend/resume events

Deferred events:

- `SourceTranscriptItemFinalized`
- `SessionInterrupted`
- `SessionReconnected`
- `SessionStopRequested`
- `TranslationExecutionCancelled`
- `TranslationCompleted`
- `TranslationOutputDeleted`
- `ExportRequested`
- `ExportArtifactCreated`
- `ExportFailed`

Deferral reasons:

- Item-level transcript events would make partial/final transcript streaming look
  like event sourcing, which is not the Phase 2B model.
- Interrupt, reconnect, and stop-request events need final lifecycle semantics
  before they are domain facts.
- Cancel, completed, and deleted translation events belong with Phase 2C
  retry/cancel/delete behavior.
- Export events imply workflow tracking or artifact lifecycle. Phase 2B keeps
  export as application runtime behavior without persisted artifacts.

## 13. Event Envelope

Required envelope shape:

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

## 14. State Ownership Matrix

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
- The Application Layer must classify runtime failure before deciding whether it
  becomes a domain lifecycle transition.
- Translation execution failure does not affect Session status.

## 15. Deferred Scope

Deferred from Phase 2B:

- Durable database.
- Event outbox.
- Broker.
- Event replay.
- Raw audio storage.
- Text-to-speech regeneration.
- Billing.
- Multi-tenancy.
- Production deployment concerns.
- Provider selection UI.
- Multi-output UI.
- Retry/cancel/delete behavior.
- Output version UI.

## 16. Exit Criteria

Phase 2B-1 exit criteria:

- Architecture documents consistently use `Application Layer`,
  `SourceTranscript`, `TranslationRequest`, `TranslationExecution`,
  `TranslationOutput`, and `Compatibility Adapter`.
- `TranslationJob` is not described as a canonical future entity.
- Current implementation, Phase 2B target, Phase 2C target, and Deferred scope
  are clearly separated.
- Aggregate and repository boundaries are documented.
- Provider ports are documented.
- Read-model contracts are documented.
- Lightweight domain event contracts and envelope are documented.
- No production code is changed.
- No tests are required for the documentation-only update.
