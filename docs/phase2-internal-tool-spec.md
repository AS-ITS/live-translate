# Phase 2 Internal Tool Spec

## 1. Phase 2 Overview

Phase 2 evolves Live Translate from a controlled Phase 1 demo into an internal
tool that a small team can use repeatedly with more predictable behavior,
recoverability, and operational visibility.

The Phase 2 direction keeps the core browser-to-Gemini Live API audio path from
Phase 1. The backend continues to own `GEMINI_API_KEY` and issue short-lived
ephemeral tokens. New Phase 2 capabilities should be added around the session
experience, local or server-side records, basic access restrictions, and usage
visibility without turning the app into a public production service.

This document is planning-only. It does not select a storage engine, implement a
database, change APIs, or change production code.

## 2. Phase 2 Goals

- Basic access control.
- Translation history.
- Subtitle export.
- Audio input device selection. Audio Device Selection v1 completed.
- Audio output device selection remains future work because browser output
  routing support is limited.
- Recently used languages.
- Session history.
- Session Lifecycle Management.
- Connection Resilience. Depends on Session Lifecycle Management.
- AudioWorklet migration.
- Better transcript handling. Completed. See
  [Better Transcript Handling](features/better-transcript-handling.md).
- Usage logging.

## 3. Phase 2 Non-Goals

- Public production service.
- OAuth / SSO.
- RBAC.
- Billing.
- Payment.
- Multi-tenant organization.
- Public user registration.
- Meeting room system.
- Full admin dashboard.

## 4. Capability-Based Planning

Phase 2 should no longer be planned primarily as a pile of isolated small
features. Follow-up work should be grouped into capabilities that describe a
coherent product and technical area.

A capability should usually support multiple related implementation features.
For example, Auto Reconnect should not be designed as a standalone spec. It
belongs under a future Connection Resilience capability with Token Refresh,
Retry Policy, Timeout Strategy, and Recovery UX.

Connection Resilience depends on
[Session Lifecycle Management](features/session-lifecycle.md). The lifecycle
spec defines the session states, transitions, cleanup rules, close/error
reasons, and UI mapping that reliability work builds on.

Connection Resilience has its own capability specification:
[Connection Resilience](features/connection-resilience.md). Before implementing
Auto Reconnect, Token Refresh, Retry Policy, Timeout Strategy, or Recovery UX,
use that specification together with the Session Lifecycle model.

## 5. Feature Breakdown

### Access Control

#### Purpose

Restrict the internal tool to approved users or approved access tokens while
keeping authentication simpler than Phase 3 production auth.

#### User Flow

1. The user opens the app.
2. The app verifies the user has internal access before allowing session start.
3. If access is missing or expired, the user sees a controlled access error.
4. Authorized users can start Live Translate sessions normally.

#### Functional Requirements

- Preserve the existing `/api/live-token` auth gate.
- Add or formalize a basic internal access mechanism if Phase 2 requires login.
- Prevent unauthorized token issuance.
- Avoid exposing `GEMINI_API_KEY`, ephemeral tokens, or internal access secrets in
  logs or frontend source.
- Keep error responses stable and avoid stack traces.

#### API / Data Requirement

- `UserAccess` data may be required if access is user-based.
- If access remains token-based, persistent user records may not be required.
- `/api/live-token` must continue to enforce access before creating Gemini
  ephemeral tokens.

#### Frontend Impact

- Add an access state before session start if login or access entry is required.
- Surface access failures separately from microphone, token, or Gemini session
  failures.
- Keep the translation UI unavailable until access is valid.

#### Backend Impact

- Validate internal access before issuing live tokens.
- Protect any future session, history, export, and usage endpoints with the same
  access mechanism.
- Ensure CORS, origin checks, rate limiting, and security headers remain in
  place.

#### Testing Requirement

- Integration tests for allowed and denied access.
- Integration tests confirming `/api/live-token` still rejects unauthorized
  requests.
- E2E test for access failure or access success if a UI login flow is added.

#### Risk / Notes

- Login may imply user storage, session cookies, password handling, or secret
  rotation. Keep the Phase 2 mechanism intentionally small unless stronger auth
  is explicitly selected.
- OAuth / SSO and RBAC are Phase 3 non-goals for this phase.

### Translation History

#### Purpose

Let internal users review previous translation sessions and reopen session-level
transcripts when storage is selected.

#### User Flow

1. The user finishes a translation session.
2. The app records session metadata and transcript items if history is enabled.
3. The user opens a history view.
4. The user selects a previous session and reviews its transcript.
5. The user may delete a saved session if deletion is supported.

#### Functional Requirements

- Save session metadata, target language, timestamps, and final transcript
  content when enabled.
- Clearly distinguish active-session transcript state from persisted history.
- Support listing, viewing, and deleting saved sessions if server-side storage is
  selected.
- Avoid storing raw audio unless explicitly approved later.

#### API / Data Requirement

- Data models: `Session`, `TranscriptItem`.
- Candidate APIs:
  - `GET /api/sessions`
  - `GET /api/sessions/:id`
  - `DELETE /api/sessions/:id`
- Storage choice is unresolved: localStorage, file-based storage, SQLite, or
  MariaDB.

#### Frontend Impact

- Add a session history view or panel.
- Add loading, empty, error, and deleted states for history.
- Ensure transcript display can render stored final items, not only live partial
  updates.

#### Backend Impact

- If storage is backend-owned, add persistence and protected history endpoints.
- Enforce access checks on all history endpoints.
- Avoid logging transcript content unless explicitly approved.

#### Testing Requirement

- Unit tests for transcript serialization and ordering.
- Integration tests for list, detail, and delete endpoints if implemented.
- E2E tests for saving a session and reopening history when the UI flow exists.

#### Risk / Notes

- Transcript content may contain sensitive information. Retention, deletion, and
  access controls need explicit decisions before implementation.
- Storage should not be introduced until the retention and deployment model are
  confirmed.

### Transcript Export

#### Purpose

Allow internal users to export transcript content for review, subtitles, or
documentation.

#### User Flow

1. The user completes or opens a saved translation session.
2. The user chooses an export format.
3. The app downloads the transcript file.

#### Functional Requirements

- Support export from final transcript items.
- Preserve transcript order and timestamps when available.
- Candidate formats: TXT, SRT, VTT.
- Handle missing or partial timestamps gracefully.

#### API / Data Requirement

- Candidate API: `GET /api/sessions/:id/export`.
- Query parameters may select format, for example `?format=vtt`.
- If history is frontend-only, export may be implemented fully in the browser and
  this API may not be required.

#### Frontend Impact

- Add export controls on active or saved transcript views.
- Show unavailable states when no final transcript items exist.
- Trigger downloads with clear file names.

#### Backend Impact

- If backend export is selected, load session transcript data and return the
  selected file format.
- Enforce access checks and avoid exposing sessions across users.

#### Testing Requirement

- Unit tests for TXT, SRT, and VTT formatting if selected.
- Integration tests for export endpoint format negotiation if backend-owned.
- E2E test for downloading an export from a saved session.

#### Risk / Notes

- SRT and VTT quality depends on reliable segment timestamps. Better transcript
  handling should come before subtitle export.

### Device Selection

Status: Audio Device Selection v1 completed for input device selection. Output
device selection remains future work and is browser-limited.

#### Purpose

Let users choose the microphone used for translation, improving repeat use in
internal environments with multiple audio input devices. Speaker device
selection remains a future enhancement because browser output routing support is
limited.

#### User Flow

1. The user opens device settings.
2. The app lists available microphones after permission is granted.
3. The user selects an input device.
4. The next session uses the selected devices when available.

#### Functional Requirements

- List available audio input devices through browser media device APIs.
- Use the selected input device for microphone capture.
- Persist recent device choices locally if appropriate.
- Fall back safely when a selected device is unavailable.
- Output device selection remains future work and depends on browser support
  such as `setSinkId`.

#### API / Data Requirement

- `GET /api/devices` is probably not required because browser devices are local
  to the client and should be handled by the frontend.
- No backend data is required unless device preferences become server-synced.

#### Frontend Impact

- Add input device controls.
- Handle permission-dependent device labels.
- Preserve current behavior when no device is selected.

#### Backend Impact

- No backend change expected for browser-local device selection.

#### Testing Requirement

- Unit tests for device selection state and fallback behavior.
- E2E tests with mocked media devices.
- Manual browser checks for microphone labels.

#### Risk / Notes

- Output device selection support varies by browser and remains out of scope for
  v1.
- Device IDs can change between sessions and should be treated as preferences,
  not guaranteed stable identifiers.

### Session Management

#### Purpose

Improve how the app tracks live sessions, completed sessions, recently used
languages, and visible transcript state.

#### User Flow

1. The user selects a target language and starts a session.
2. The app creates an explicit session record in memory or storage.
3. The app updates session status as connecting, listening, stopped, or failed.
4. The app remembers recent target languages.
5. The user can review session history if storage is enabled.

#### Functional Requirements

- Track session lifecycle state consistently.
- Preserve recent target languages.
- Record session start time, stop time, status, and target language.
- Keep failed sessions distinguishable from completed sessions.
- Avoid duplicate active sessions.

#### API / Data Requirement

- Data model: `Session`.
- Candidate APIs:
  - `GET /api/sessions`
  - `GET /api/sessions/:id`
  - `DELETE /api/sessions/:id`
- Recent languages may be local-only unless multi-device continuity is required.

#### Frontend Impact

- Refine session state handling and transcript state boundaries.
- Add recent language affordances if selected for implementation.
- Keep start/stop behavior clear during reconnect or token refresh.

#### Backend Impact

- Backend session records are needed only if server-side history or usage
  tracking is selected.
- Backend must not proxy live audio.

#### Testing Requirement

- Unit tests for session lifecycle transitions.
- Unit tests for recent language persistence if implemented.
- E2E tests for repeated sessions and session history behavior.

#### Risk / Notes

- Session management changes can affect the core live session flow. Keep changes
  incremental and covered by targeted tests.

### Session Lifecycle Management

#### Purpose

Define an explicit session lifecycle model before implementing Auto Reconnect or
Token Refresh. This feature clarifies session states, allowed transitions,
cleanup behavior, error reasons, and reconnect readiness while preserving the
existing Gemini Live session and token flow.

See [Session Lifecycle Management](features/session-lifecycle.md).

#### User Flow

1. The user starts and stops sessions through the existing controls.
2. The app moves through explicit lifecycle states such as permission request,
   connecting, listening, stopping, stopped, and error.
3. The app records why a session closed or failed in memory.
4. The UI maps each lifecycle state to stable controls, status messages, and
   error display behavior.
5. Future reconnect or refresh behavior can use the same lifecycle model without
   changing the initial token flow.

#### Functional Requirements

- Define the session state model.
- Define legal state transitions and reject invalid transitions.
- Distinguish user stop, unexpected close, token or auth failure, network
  failure, provider error, and cleanup failure.
- Define deterministic cleanup for user stop, errors, unexpected close, page
  unload, React unmount, and token or auth failure.
- Define UI mapping for controls, status messages, and error display.
- Define future reconnect readiness data without activating reconnect behavior.
- Keep the current Gemini Live session and token flow unchanged.
- Do not implement reconnect behavior in this feature.

#### API / Data Requirement

- No backend API is required.
- No database or persistence is required.
- No change to `/api/live-token` is required.
- Session lifecycle state can remain frontend-local unless a later Session
  History or Usage Logging feature explicitly selects persistence.

#### Frontend Impact

- Refine the frontend session state machine and cleanup boundaries when this
  feature is implemented.
- Reserve future-ready states such as `reconnecting` and `expired` without
  requiring immediate UI behavior.
- Keep transcript state, selected target language, and selected input device
  available as reconnect readiness inputs for future work.

#### Backend Impact

- No backend change.
- The backend-owned `GEMINI_API_KEY` and ephemeral token issuance flow remain
  unchanged.

#### Testing Requirement

- Unit tests for valid and invalid lifecycle transitions.
- Unit tests for close and error reason mapping.
- Unit tests for cleanup path selection.
- UI tests or component tests for lifecycle-to-control mapping if UI behavior is
  changed.
- Reconnect and expired states should be reserved but not active until a later
  feature explicitly implements them.

#### Risk / Notes

- This is a planning and foundation feature. It should not reconnect sessions,
  refresh tokens, change Gemini Live API integration, add backend APIs, or add
  persistence.
- The lifecycle model should be stable enough for future Auto Reconnect, Token
  Refresh, Session History, and Usage Logging work.

### Connection Resilience

#### Purpose

Improve session reliability when a Gemini Live session disconnects, an
ephemeral token or session expires, the browser goes offline, provider errors
occur, or audio/browser resources need controlled recovery.

Depends on: Session Lifecycle Management.

See [Connection Resilience](features/connection-resilience.md).

#### User Flow

1. The user starts a session.
2. The app classifies any recoverable failure.
3. The app applies the selected retry, timeout, and token refresh policy.
4. The app reconnects with minimal user interruption or clearly asks the user to
   restart if automatic recovery is unsafe.

#### Functional Requirements

- Detect expected stop, unexpected disconnect, token failure, and provider
  errors separately.
- Classify failures before choosing a recovery path.
- Apply bounded retry attempts and avoid aggressive loops.
- Request fresh ephemeral tokens before reuse or reconnect.
- Monitor basic connection health signals such as offline/online, close/error
  events, timeouts, and audio device failures.
- Preserve transcript content already received before reconnect.
- Stop microphone tracks if reconnect cannot complete safely.
- Surface recovery state clearly in the UI.

#### API / Data Requirement

- Existing `POST /api/live-token` may be reused for refresh.
- Session metadata may record reconnect attempts and failure reason if a later
  persistence capability selects storage.
- No long-lived Gemini credential may be exposed to the browser.

#### Frontend Impact

- Add reconnecting and refresh states to the session state machine.
- Add retry limits, offline/expired handling, and user-visible recovery
  messages.
- Ensure audio capture and playback resources are cleaned up between attempts.

#### Backend Impact

- `/api/live-token` rate limits must account for legitimate refresh attempts
  without allowing abuse.
- Token issuance validation and security behavior must remain unchanged.

#### Testing Requirement

- Unit tests for failure classification, reconnect state transitions, retry
  limits, and timeout decisions.
- Integration tests for repeated token issuance under rate limits.
- E2E tests with mocked session disconnects, offline/online behavior, and token
  refresh.

#### Risk / Notes

- Reconnection may create transcript discontinuities or duplicated audio.
- Token refresh behavior depends on Gemini Live API capabilities and current SDK
  semantics, which should be confirmed before implementation.

### Audio Pipeline Improvement

#### Purpose

Move audio processing toward a more reliable, lower-latency browser pipeline and
reduce main-thread audio processing risk.

#### User Flow

1. The user starts a session as before.
2. The app captures and processes microphone audio through the improved pipeline.
3. The user experiences fewer dropouts under normal browser load.

#### Functional Requirements

- Migrate microphone processing to AudioWorklet if selected.
- Preserve PCM16 16kHz mono input format for Gemini.
- Preserve 24kHz PCM output playback handling.
- Keep stop cleanup deterministic.
- Maintain existing behavior in unsupported browsers or provide a documented
  fallback.

#### API / Data Requirement

- No backend API change expected.
- Audio pipeline metrics may feed `UsageLog` if selected.

#### Frontend Impact

- Add AudioWorklet processor code and registration flow when implementation
  begins.
- Update audio unit tests around chunking, resampling, and cleanup.
- Keep browser compatibility behavior explicit.

#### Backend Impact

- No backend change expected.

#### Testing Requirement

- Unit tests for audio conversion and chunking must remain in place.
- Browser-level E2E or manual validation for AudioWorklet startup and cleanup.
- Manual checks on supported browsers before enabling by default.

#### Risk / Notes

- AudioWorklet migration is higher risk because it touches the latency-sensitive
  path.
- It should follow lower-risk transcript and device work.

### Usage Logging

#### Purpose

Record internal usage metadata for operational visibility without storing raw
audio or secrets.

#### User Flow

1. The user starts and stops sessions normally.
2. The app records usage metadata such as session duration, target language,
   outcome, and error category.
3. An authorized internal user can review usage summaries if a usage view is
   implemented.

#### Functional Requirements

- Log session metadata without logging `GEMINI_API_KEY`, ephemeral tokens, raw
  audio, or transcript content unless explicitly approved.
- Track session start, stop, duration, target language, status, and error class.
- Support retention limits once storage is selected.

#### API / Data Requirement

- Data model: `UsageLog`.
- Candidate API: `GET /api/usage`.
- Write path may be implicit through session lifecycle events or a dedicated
  internal endpoint, pending design.

#### Frontend Impact

- Frontend may send usage events if backend cannot infer them.
- UI may expose basic usage review if selected, but a full admin dashboard is a
  non-goal.

#### Backend Impact

- Store usage records if server-side storage is selected.
- Protect usage reads with internal access control.
- Avoid sensitive data in logs and responses.

#### Testing Requirement

- Unit tests for usage event normalization.
- Integration tests for usage records and protected usage reads if implemented.
- Manual checks for sensitive-data redaction.

#### Risk / Notes

- Usage logging can become an analytics or admin-dashboard project. Keep Phase 2
  usage visibility minimal.

### UX Improvement

#### Purpose

Make repeated internal use smoother without changing the core product scope.

#### User Flow

1. The user opens the app and sees remembered preferences where appropriate.
2. The user can select recent languages and devices quickly.
3. The user can distinguish live partial transcript text from final transcript
   content.
4. Errors provide clear recovery paths.

#### Functional Requirements

- Improve transcript display for partial versus final text.
- Preserve recent target languages.
- Show clearer session states around reconnecting, stopped, and failed sessions.
- Keep the MVP start/stop flow recognizable.

#### API / Data Requirement

- Recent languages may be frontend-local.
- Transcript display improvements may reuse `TranscriptItem` shape if history is
  selected.

#### Frontend Impact

- Update transcript state handling and UI states.
- Add preference persistence where appropriate.
- Keep visual changes scoped to internal-tool usability.

#### Backend Impact

- No backend change unless preferences are stored server-side.

#### Testing Requirement

- Unit tests for transcript update behavior.
- E2E tests for core start/stop flow after UX changes.
- Manual acceptance checks for repeated-session usability.

#### Risk / Notes

- UX changes should not obscure current demo functionality.
- Avoid broad visual redesign unless explicitly requested.

## 6. Suggested Implementation Order

Suggested order from lower risk to higher risk:

1. Better transcript handling. Completed. See
   [Better Transcript Handling](features/better-transcript-handling.md).
2. Device selection.
3. Transcript export.
4. Session Lifecycle Management.
5. Usage logging.
6. Translation history.
7. Connection Resilience.
8. AudioWorklet migration.
9. Basic access control.

Rationale:

- Transcript handling and device selection can be scoped mostly to frontend
  behavior and deterministic tests.
- Export depends on transcript structure and timestamp quality.
- Session Lifecycle Management defines state, cleanup, error reasons, and
  reconnect readiness before reliability features are added.
- Usage logging and history require storage decisions and retention rules.
- Connection Resilience depends on the live session lifecycle and should cover
  retry policy, auto reconnect, token refresh, timeout strategy, health
  monitoring, and recovery UX as one capability.
- AudioWorklet migration changes the audio path.
- Basic access control can affect every API and user flow, so it should be
  designed carefully even if the final mechanism remains simple.

## 7. Data Model Draft

These models are planning drafts only. Field names and storage types should be
finalized after the storage choice is confirmed.

### Session

```json
{
  "id": "session-id",
  "userAccessId": "user-access-id-or-null",
  "targetLanguageCode": "zh-Hant",
  "status": "completed",
  "startedAt": "2026-07-07T08:00:00.000Z",
  "endedAt": "2026-07-07T08:10:00.000Z",
  "durationMs": 600000,
  "errorCode": null,
  "createdAt": "2026-07-07T08:00:00.000Z",
  "updatedAt": "2026-07-07T08:10:00.000Z"
}
```

Potential statuses:

- `active`
- `completed`
- `stopped`
- `failed`
- `expired`

### TranscriptItem

```json
{
  "id": "transcript-item-id",
  "sessionId": "session-id",
  "kind": "source",
  "text": "Recognized or translated text",
  "isFinal": true,
  "startMs": 1200,
  "endMs": 3600,
  "sequence": 1,
  "createdAt": "2026-07-07T08:00:03.600Z"
}
```

Potential `kind` values:

- `source`
- `translation`

### UsageLog

```json
{
  "id": "usage-log-id",
  "sessionId": "session-id",
  "userAccessId": "user-access-id-or-null",
  "eventType": "session_completed",
  "targetLanguageCode": "zh-Hant",
  "durationMs": 600000,
  "status": "completed",
  "errorCode": null,
  "createdAt": "2026-07-07T08:10:00.000Z"
}
```

Potential `eventType` values:

- `session_started`
- `session_stopped`
- `session_completed`
- `session_failed`
- `token_refreshed`
- `reconnect_attempted`

### UserAccess

```json
{
  "id": "user-access-id",
  "label": "internal-user-or-token-label",
  "accessType": "shared_token",
  "isActive": true,
  "lastUsedAt": "2026-07-07T08:00:00.000Z",
  "createdAt": "2026-07-07T08:00:00.000Z",
  "updatedAt": "2026-07-07T08:00:00.000Z"
}
```

Potential `accessType` values:

- `shared_token`
- `password`
- `local_user`

## 8. API Draft

These APIs are planning candidates only. They should not be implemented until
storage, access control, and retention are confirmed.

### `GET /api/sessions`

Purpose: list saved translation sessions for the authorized internal user or
internal tool scope.

Potential response:

```json
{
  "sessions": [
    {
      "id": "session-id",
      "targetLanguageCode": "zh-Hant",
      "status": "completed",
      "startedAt": "2026-07-07T08:00:00.000Z",
      "endedAt": "2026-07-07T08:10:00.000Z",
      "durationMs": 600000
    }
  ]
}
```

### `GET /api/sessions/:id`

Purpose: return one saved session and its transcript items.

Potential response:

```json
{
  "session": {
    "id": "session-id",
    "targetLanguageCode": "zh-Hant",
    "status": "completed",
    "startedAt": "2026-07-07T08:00:00.000Z",
    "endedAt": "2026-07-07T08:10:00.000Z"
  },
  "transcriptItems": []
}
```

### `DELETE /api/sessions/:id`

Purpose: delete a saved session and related transcript items if deletion is
supported.

Potential response:

```json
{
  "deleted": true
}
```

### `GET /api/sessions/:id/export`

Purpose: export a saved session transcript.

Potential query parameters:

- `format=txt`
- `format=srt`
- `format=vtt`

This endpoint may not be needed if export is implemented entirely in the
frontend from locally available transcript data.

### `GET /api/usage`

Purpose: return minimal internal usage records or summaries.

Potential response:

```json
{
  "usage": [
    {
      "sessionId": "session-id",
      "targetLanguageCode": "zh-Hant",
      "durationMs": 600000,
      "status": "completed",
      "createdAt": "2026-07-07T08:10:00.000Z"
    }
  ]
}
```

### `GET /api/devices`

Assessment: probably not needed.

Audio input and output devices are browser-local and should normally be handled
with frontend media device APIs. A backend devices endpoint would not be able to
see the user's local microphones or speakers and should be avoided unless a
future requirement introduces server-managed hardware.

## 9. Testing Strategy

### Unit Tests

- Transcript update behavior for partial and final source transcript items.
- Transcript update behavior for partial and final translated transcript items.
- Transcript export formatting for selected formats.
- Session lifecycle state transitions.
- Device preference and unavailable-device fallback behavior.
- Usage event normalization and redaction.
- Audio conversion and chunking coverage must remain intact during AudioWorklet
  migration.

### Integration Tests

- Protected `POST /api/live-token` behavior remains intact.
- Access control rejects unauthorized API requests when implemented.
- Session list, detail, delete, and export endpoints if backend storage is
  selected.
- Usage read endpoint if implemented.
- Token refresh requests under rate limits.
- Stable structured errors for invalid JSON, unsupported languages, missing
  configuration, and provider failures.

### E2E Tests

- Core start/stop translation flow still reaches `Listening` and stops cleanly
  with mocks.
- Device selection with mocked media devices.
- Transcript finalization and export from a mocked session.
- Session history list and detail flow if history is implemented.
- Reconnect and token refresh behavior with mocked disconnects.
- Access control flow if login or access entry is added to the UI.

### Manual Acceptance Tests

- Browser microphone permission and device labels behave as expected.
- Audio output device selection works where the browser supports it.
- Repeated sessions do not leak microphone tracks or audio contexts.
- Exported TXT, SRT, or VTT files are readable and ordered correctly.
- Sensitive values are not visible in browser logs, server logs, or responses.
- Real Gemini smoke testing remains opt-in with `ENABLE_REAL_GEMINI_TEST=true`.

## 10. Documentation Updates Needed

If Phase 2 implementation begins, update:

- `docs/spec.md`: add selected Phase 2 functional and non-functional
  requirements.
- `docs/api.md`: document any new endpoints, request bodies, response bodies,
  validation, and errors.
- `docs/architecture.md`: document storage, access control, session history, and
  any AudioWorklet architecture changes.
- `docs/ROADMAP.md`: update Phase 2 status and selected feature scope.
- `docs/TESTING.md`: add test commands and coverage for Phase 2 features.
- `README.md`: update setup and usage instructions for internal-tool behavior.
- `AGENTS.md`: update phase rules and validation guidance if Phase 2 becomes
  the active implementation phase.

## 11. Open Questions

- Is login actually required for Phase 2, or is the current access-token gate
  sufficient for internal use?
- Should translation history be saved in localStorage, file-based storage,
  SQLite, MariaDB, or another storage layer?
- Should transcript export support TXT, SRT, VTT, or only a subset?
- How long should usage records and transcript history be retained?
- Should Phase 2 support multiple internal users, or only a shared controlled
  internal environment?
- Should transcript content be stored server-side, or should only metadata and
  usage logs be stored?
- Should users be able to delete individual sessions, or should retention be
  automatic only?
- Are recent languages and device preferences local-only, or should they follow
  the user across devices?
- What reconnect behavior is acceptable if a session drops mid-sentence?
- Should token refresh happen proactively before expiration or only after a
  recoverable failure?
- Which browsers must support AudioWorklet and output device selection?
- Is an admin usage review page required, or is a simple API/report enough for
  Phase 2?
