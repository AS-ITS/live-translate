# Live Translate API and Events

## 現行 Meeting API 契約

`/api/meetings/:meetingId/recording/*` and `/api/meetings/:meetingId/heartbeat`
return `410 meeting_content_local_only`. The Host owns recording Session, Segment,
Cue, Checkpoint, audio, and recovery in IndexedDB/OPFS without a cloud recording
Lease. `POST /api/live-token` retains authenticated Meeting `canRecord` permission
and matching Host-local Session/Segment headers. `POST /api/meetings/:meetingId/complete`
atomically sets `status=completed`, the first `ended_at`, `purge_at` 30 minutes later,
and increments `lifecycle_version` once after local sealing. A draft Meeting uses
`created_at` as `started_at` if it has not started. Repeated End preserves these
values; settings updates cannot overwrite terminal fields. Viewer metadata exposes
the new lifecycle version. Meeting settings, glossary, membership, sharing,
and WebRTC signaling APIs remain available. Older recording routes below describe
historical behavior and are no longer writable.

For current Meeting recording, `GET /api/shared-meetings/:token/metadata` (or
the short-code variant) returns authorized Meeting metadata only. The Viewer
receives Cue snapshots, updates, and replay from the Host over WebRTC
DataChannel. Supabase Realtime, Meeting SSE, cloud Cue／Transcript／Checkpoint,
and cloud recovery are not current recording or Viewer subtitle transports.
The historical request／response examples below do not override this contract.

## Viewer metadata authorization

`GET /api/shared-meetings/:token/metadata` and `GET /api/shared-meetings/code/:shortCode/metadata` accept a valid, unrevoked, unexpired Viewer share without a login Bearer token. Other shares do not authorize metadata. Responses contain Meeting identity, setting labels, lifecycle status/version, recording state and connection metadata; they omit Cue, Transcript, Checkpoint, audio and event content. Viewer shares do not grant Host export permission. Expired Meeting content returns `410 meeting_content_expired`. Deployed Origin/CORS checks remain allowlist-only.

## Host Local-only Start/Stop token boundary

The Host creates and persists recording Session and Segment identities in IndexedDB. `POST /api/live-token` accepts `x-host-local-recording: 1` with matching `x-meeting-session-id` and `x-meeting-segment-id` headers for this path. It validates the authenticated actor's Meeting `canRecord` permission and uses cloud Meeting language and glossary settings; it does not read or write a cloud recording Session, Segment, lease, or Checkpoint. The token endpoint retains its origin gate and rate limit. Host Start, Pause, Continue, Stop, and End persist recording state locally. Rollover and interrupted recovery use local durable records; Viewer metadata supplies only Meeting state.

### 已退役內容端點

Meeting Cue, Checkpoint, transcript, translated output, audio upload, and Cloud Export content reads／writes return `410 meeting_content_local_only`; authorized deletion methods are separate from these content routes. Legacy shared Session content reads are closed. Meeting settings, glossary, sharing, Meeting completion metadata and Viewer WebRTC signaling remain available. Meeting detail and Segment list responses omit historical content; Host local IndexedDB/OPFS supplies transcript and audio exports after Reload. The isolated Cutover Migration also rejects direct table/RPC/Storage writes, while preserving existing historical rows for separate controlled cleanup. No Production Migration has run.

## Current Meeting expiry policy (2026-10-07)

Successful completion freezes the existing database-generated `ended_at` and
`purge_at = ended_at + 30 minutes`. At `purge_at`, ordinary Meeting list/detail
reads hide the Meeting and Viewer/content routes return the canonical
`410 meeting_content_expired`. Active `super_admin` reads retain metadata with
derived `isPendingDelete: true`, but not expired recording content. Expiry does
not run physical cleanup; the existing authorized
`DELETE /api/meetings/:meetingId` path is the only cloud deletion path. This
policy supersedes older cleanup-worker wording below.

## `GET /api/runtime-config`

Public, browser-safe startup configuration. The response is not cached and
contains exactly one allowlisted boolean:

```json
{
  "livePipelineTraceEnabled": false
}
```

The server derives it from strict `LIVE_PIPELINE_TRACE_ENABLED=true` opt-in. No
other environment variables, credentials, tokens, or authorization data are
exposed.

## Gemini credential boundary

The old profile credential API (`/api/profile/gemini-credential`) and its
`gemini_credentials` store have been removed. Live token issuance accepts only
the authenticated recorder's request-scoped `geminiApiKey`; it does not read a
stored key or the server `GEMINI_API_KEY` environment variable. The request key
is used only to create the short-lived token, then discarded. It is never
persisted, returned, logged, or included in telemetry. Viewer requests do not
request or receive a Gemini key or token.

Non-Live backend workers may use an isolated `GEMINI_API_KEY` when their own
provider configuration requires it; that key is not part of the Live token
flow.

## Host-local Cue read model

The active Meeting recorder commits Final Cues and Checkpoint cursors in Host IndexedDB. The Viewer receives Host Cue snapshots and updates through WebRTC DataChannel. A separate source-only transcription and Flash refinement pipeline remains a planned contract, not a current Meeting API.


The API treats a Cue with at least one finalized side as a stable publishable
unit. Source and translation completion are independent.

### Cue read model

```json
{
  "cueId": "cue:session-1:segment-1:7",
  "sessionId": "session-1",
  "segmentId": "segment-1",
  "sequence": 7,
  "startTimeMs": 12000,
  "endTimeMs": 14500,
  "sourceLanguageCode": "zh-Hant",
  "targetLanguageCode": "en",
  "sourceText": "正式原文。",
  "sourceStatus": "finalized",
  "sourceVersion": 1,
  "initialTranslation": "Initial translation.",
  "refinedTranslation": null,
  "translationStatus": "finalized",
  "translationVersion": 1,
  "refinementStatus": "queued",
  "version": 1,
  "status": "final"
}
```

`cueId`, `sessionId`, `segmentId`, `sequence`, `startTimeMs`, and language identity define Cue identity. `endTimeMs` may extend for a proven same-turn late-final update. Source and translation versions may advance independently on the same `cueId`; a text correction requires newer provider-event evidence for that turn. Each accepted content change advances Cue revision. Local-only Final Cues and their Checkpoint cursor commit atomically in IndexedDB; the Local Cue Store is the reload authority. An equal revision with different content is a conflict.
Consumers compute the effective translation as
`refinedTranslation → initialTranslation → legacy translatedText`.

### Planned refinement operations

The source-only transcription and asynchronous Flash refinement design is future work. It does not authorize cloud Cue writes, a Meeting Recording Worker, or Viewer SSE delivery in the current Meeting flow.


## Global glossary import

Authenticated clients can preview and atomically import a UTF-8 CSV, JSON, or XLSX
glossary through `POST /api/glossary/import/preview` and
`POST /api/glossary/import`. Both requests use
`{ format: "csv" | "json" | "xlsx", content: "...", sourceLanguageCode: "...", targetLanguageCode: "...", category: "..." }`.
XLSX content is a base64-encoded workbook whose first worksheet starts with
`source` and `translation` headers. CSV content uses `source,translation`
columns. JSON content uses an `entries` array whose items contain `source` and
`translation` strings. For example, all three formats can contain multiple rows
such as:

For XLSX, the worksheet should use the same columns shown below in its first row.

```csv
source,translation
產品名稱,Product name
會議室,Meeting room
翻譯結果,Translation result
```

```json
{
  "entries": [
    { "source": "產品名稱", "translation": "Product name" },
    { "source": "會議室", "translation": "Meeting room" },
    { "source": "翻譯結果", "translation": "Translation result" }
  ]
}
```

The selected languages and category are applied to every imported row. The commit
request also sends the preview `baseRevision`, a `resolutions` map keyed by row
number with `update` or `skip` for conflicts, and an optional `selectedRows`
array of source row numbers. When `selectedRows` is present, unselected rows are
skipped. The server validates selected rows before writing; invalid selected
rows reject the whole batch, while invalid unselected rows can be left out.
Rows that repeat a source term within the same import are reported with
`status: "duplicate"` and counted in `summary.duplicates`, not
`summary.invalid`; they are skipped automatically during commit. Existing
glossary entries remain `status: "conflict"` rows and require `update` or
`skip` resolution.
Omitting `selectedRows` preserves the legacy all-rows behavior. A changed
revision returns `409 glossary_revision_conflict`.

## Meeting Center and Live Viewer

The per-Meeting WebRTC signaling sequence cursor is renewed by participant
heartbeat and must not reset while a participant remains active; individual
offer/answer/ICE messages still expire independently.

The deployed WebRTC signaling route requires
`WEBRTC_SIGNALING_REDIS_URL` and `WEBRTC_SIGNALING_REDIS_TOKEN`. Optional
server-only `WEBRTC_ICE_SERVERS_JSON` is a JSON `RTCIceServer[]`; only explicit
STUN/TURN URL schemes are accepted, and invalid JSON or entries fail signaling
startup without logging credentials. Cross-network reliability requires a
reachable TURN service; configuration alone is not acceptance evidence.
`POST /api/webrtc/:meetingId/signal` accepts `viewer-ready`, `offer`, `answer`,
and `ice-candidate`. Viewers send `viewer-ready` with a `negotiationId`; offers,
answers, and candidates include that ID and `targetParticipantId`. Poll results
only expose messages for the joined participant or legacy untargeted messages.
The server verifies the target participant and role. Viewer access still uses
the existing share code/token, while Device access uses recording permission.

## Meeting glossary import preview

Meeting Settings can preview a CSV, JSON, or XLSX file for private Meeting
glossary entries through `POST /api/meetings/glossary/import/preview`. The
request is `{ format, content, sourceLanguageCode, targetLanguageCode,
existingEntries }`; XLSX content is base64 encoded. The endpoint is read-only:
it returns preview rows with `create`, `conflict`, `duplicate`, or `invalid`
status and does not change either the Meeting or global glossary. Confirmed
rows are sent later as part of the existing Meeting create/update request's
`privateGlossaryEntries` field.

The Meeting-scoped Viewer API, private glossary fields, Storage upload, and
Realtime contracts are documented in
[Meeting Center and Live Viewer](features/meeting-center-live-viewer.md).

## Authenticated execution WebSocket

`WS /api/sessions/:sessionId/execution-events` streams execution status for one
Session. The first message must be
`{"type":"auth","token":"<supabase-access-token>"}`; invalid or missing
authentication closes the connection. The token is never placed in the URL.

Messages are safe snapshots containing no stack traces, API keys, ephemeral
tokens, or unsaved provider data. Each Session has a monotonically increasing
`sequence` in the current process:

```json
{"type":"execution.snapshot","sequence":12,"sessionId":"session-1","execution":{"id":"execution-2","requestId":"request-1","translationRequestId":"request-1","status":"queued","targetLanguageCode":"ja","startedAt":null,"createdAt":"2026-08-10T00:00:00.000Z","providerAttemptStatus":"not_started","providerAttemptedAt":null,"providerCompletedAt":null,"completedAt":null,"failureInfo":null}}
```

Events are not replayed after reconnect. Clients refetch the authenticated REST
read model, then subscribe again. The frontend reconnects with backoff and
falls back to the existing two-second polling interval after repeated failures.

## Retired execution-content routes

Current translation execution and dead-letter queue content reads／writes return `410 meeting_content_local_only`. `GET /api/translation-providers` remains a separate provider-options read and does not expose credentials.


## Meeting metadata reads

`GET /api/meetings` and `GET /api/meetings/:meetingId` return authorized Meeting metadata, settings, status, sharing and lifecycle information. The detail response does not provide the current recording's Cue, Transcript, Checkpoint or audio content. Host Meeting Detail reads those records from its own IndexedDB／OPFS; another device cannot recover them from these APIs. An unknown Meeting returns `404`; expired content follows the expiry rule above.

## `POST /api/meetings`

Creates a Meeting draft with its name, source/target languages, audio settings and selected glossary entries. Creating a Meeting does not start microphone capture or a Gemini Live session. The Host creates and persists recording Session／Segment identities locally when recording starts.

## `PATCH /api/meetings/:meetingId`

更新經授權的 Meeting 設定與字典欄位；錄製開始後受鎖定的設定不能被覆寫，回傳 `409 meeting_settings_locked`。此端點不接受錄製 Cue、音訊、Transcript 或 Checkpoint。

## `DELETE /api/meetings/:meetingId`

Authorized deletion removes Meeting metadata under the existing ownership and lifecycle checks. It cannot immediately erase another browser's OPFS／IndexedDB; local cleanup occurs when that Host next checks the Meeting's authorization or expiry.


## `POST /api/meetings/:meetingId/complete`

After the Host seals local recording data, this endpoint completes Meeting metadata. The first completion fixes `ended_at` and `purge_at` at 30 minutes later and advances `lifecycle_version`; a repeated completion preserves those values. Active recordings return `409 meeting_complete_not_allowed`. Completion does not upload recording content.


## `GET|POST /api/meetings/:meetingId/shares`

Lists active Recorder shares or creates a Recorder share after Meeting settings
are saved. `POST` returns the opaque token and short-code URLs once; later list
responses contain metadata only. Completed Meetings keep existing shares
available for viewing, but `POST` returns `409 meeting_share_locked`.

## `DELETE /api/meetings/:meetingId/shares/:shareId`

Revokes one Meeting share. Existing Viewer shares may be revoked after a Meeting
is completed; completed Meetings still reject new share creation and settings
changes.

## Glossary

## `GET /api/glossary`

Returns the global translation glossary.

Global entries are visible to all Meetings and can be selected into an
individual Meeting glossary snapshot. Meeting-private entries are stored on the
Meeting and are not returned by this endpoint. Entries may include
`sourceLanguageCode`, `category`, `tags`, `enabled`, and `notes`; legacy entries
default to Traditional Chinese source language, `other` category, enabled, and
empty tags/notes.

When `TRANSLATION_GLOSSARY_FILE` is unset, the backend uses
`translation-glossary.json` under `DATA_DIR`. If `DATA_DIR` is unset, it
defaults to `./data` outside production and `/var/data` in production. If the
file does not exist, the glossary is empty; the first successful create request
writes the file.

```json
{
  "entries": [
    {
      "id": "entry-1",
      "source": "Codex",
      "translations": {
        "ja": "コーデックス"
      },
      "scope": "history",
      "createdAt": 1000,
      "updatedAt": 1000
    }
  ]
}
```

## Glossary category management

`GET /api/glossary/categories` returns the ordered category list. `POST
/api/glossary/categories` creates a category from `{ "label": "專案名詞" }`;
`PUT /api/glossary/categories/:categoryId` edits its label;
`PUT /api/glossary/categories/order` accepts `{ "categoryIds": [...] }` and
persists the order; and `DELETE /api/glossary/categories/:categoryId` deletes a
category and reassigns its entries to `other`. Labels cannot be blank or
duplicated, category IDs remain stable after creation, and `other` cannot be
deleted. Entry create/update requests may use any ID returned by this endpoint;
an unknown category ID returns `400 invalid_request`. Legacy files containing only `entries` are upgraded in memory with the
default categories and are written in the new `{ categories, entries }` shape
on the next successful mutation.

## `POST /api/glossary/entries`

Creates one manually maintained global glossary entry.

```json
{
  "source": "microphone",
  "translations": {
    "en": "Alan speak"
  },
  "scope": "both"
}
```

Returns `201 Created` with `{ "entry": ... }`.

## `PUT /api/glossary/entries/:entryId`

Replaces the source term and translations for an existing glossary entry.

Returns `200 OK` with `{ "entry": ... }`. Missing entries return `404`.

## `DELETE /api/glossary/entries/:entryId`

Deletes an existing glossary entry.

Returns `200 OK` with the deleted `{ "entry": ... }`. Missing entries return
`404`.

Glossary validation uses the supported target-language allowlist. Blank source
terms, blank translations, empty translation maps, unsupported language codes,
unsupported scopes, and blank replacement aliases are rejected. `scope` may be
`live`, `history`, or `both`; omitted scope defaults to `history` for legacy
compatibility. The primary product behavior is deterministic subtitle text
replacement: `source` is the text to find in translated subtitles, and
`translations[targetLanguageCode]` is the text to display instead. Legacy
`replacementAliases` is still accepted for existing data and API compatibility
when explicitly provided, but current glossary entries omit it from stored JSON
when there are no aliases.

Glossary replacement is applied deterministically to translated subtitle text
for live output and saved retranslation output. Live glossary instructions also
ask Gemini to use the configured terms in translated speech audio, but the
frontend does not post-process generated audio after Gemini returns it. Source
transcripts are not rewritten.

Meeting-scoped glossary entries use the same source/translation structure but
are stored on the Meeting and copied into each Segment settings snapshot. They
are reused by each Segment and saved retranslation until the Meeting settings
are changed; a change applies to the next Segment and does not rewrite earlier
Segment history.

## Execution Control

## `GET /api/translation-providers`

Returns the backend-supported provider options that are safe for saved Session
re-translation UI selection. The response exposes only stable UI metadata, not
provider credentials or internal client configuration.

```json
{
  "providers": [
    {
      "key": "gemini",
      "label": "Gemini",
      "provider": "gemini",
      "model": "gemini-3.5-flash"
    }
  ]
}
```

The `model` value is resolved from `SAVED_RETRANSLATION_GEMINI_MODEL`, falling
back to the backend default when the environment variable is unset.

### Retired execution mutations

`POST /api/translation-executions/:executionId/cancel` and `/retry` return `410 meeting_content_local_only` in the current Local-only API.


## Historical Session content contracts

The Session read／update, audio, translation and retranslation examples below describe the earlier file-backed flow. Current Local-only content routes return `410 meeting_content_local_only`; authorized deletion routes remain separate. They do not provide Meeting recording content or Viewer subtitles.

## `POST /api/sessions/:sessionId/retranslations`

Queues a new translation execution from the Session's canonical final source
transcript. The request body may contain only `targetLanguageCode` and optional
`providerKey`; source text, source language, transcript items, and source
metadata are always derived by the server.

```json
{ "targetLanguageCode": "ja", "providerKey": "gemini" }
```

The endpoint returns `202 Accepted` with the newly created request and queued
execution. Submission validates the provider selection but does not call the
provider, runner, or worker and does not create a translation output. Each valid
submission creates a new request/execution pair.

The client must not send `sourceText`, source language, transcript items, source
metadata, or a version. The server derives canonical source text and provenance
from the persisted Session and request state. On completion, it allocates the
formal output version by `(sessionId, targetLanguageCode)`. Completed
retranslation outputs remain attached to the original Session's translation
history read model and are not materialized as separate translation history
records.

The dedicated translation history endpoint includes `translationHistory.outputs`
for formal completed outputs and `translationHistory.executions` for executions
without an output. Formal output versions are scoped to
`(sessionId, targetLanguageCode)` and are ordered by completion time, newest
first.

`GET /api/sessions/:sessionId` keeps completed retranslation output out of the
original Session detail. Completed retranslation articles are shown through the
dedicated retranslation workflow using `GET /api/sessions/:sessionId/translations`.
Original Session detail may include non-terminal or failed execution progress so
the UI can show queued, processing, or failed work without placing completed
output back on the source record:

```js
{
  translationHistory: {
    outputs: [],
    executions: [
      {
        id,
        requestId,
        targetLanguageCode,
        status, // queued | running | processing | failed
        startedAt,
        createdAt,
        providerAttemptStatus, // not_started | in_flight | succeeded | failed
        providerAttemptedAt,
        providerCompletedAt,
        failureInfo
      }
    ]
  }
}
```

When a Live session finalizes successfully with status `stopped` or
`completed`, the command lifecycle materializes one article-level
`TranslationOutput` for the session and target language. The output uses the
stable id `live-output:${sessionId}:${targetLanguageCode}`, stores the complete
article text in `translatedText`, stores the merged final source transcript in
`sourceText` when available, and retains the final source transcript revision
and snapshot in `sourceTranscriptMetadata`.

`GET /api/sessions/:sessionId` also includes `readingContent` for history
detail reading. `translationArticle` is formal-output first: when a formal
`TranslationOutput` exists, its `translatedText` is the official article text
and exposes the formal output `version`. Legacy sessions without a formal
output still fall back to server-side projection from persisted final transcript
items so older history remains readable:

The same Session detail also includes `cues`, containing only final subtitle
Cues merged from all persisted Segments and sorted by `sequence`. Each Cue
contains `rawSource`, `rawTranslation`, optional `refinedSource` and
`refinedTranslation`, plus versioned `refinement` status metadata. Partial Cue
checkpoint state is never exposed through this read model.

```js
{
  readingContent: {
    translationArticle: {
      status, // available | processing | failed | empty
      targetLanguageCode,
      targetLanguageLabel,
      version,
      text,
      paragraphs,
      createdAt,
      completedAt,
      emptyReason
    },
    sourceTranscript: {
      status, // available | processing | failed | empty
      text,
      paragraphs,
      createdAt,
      finalizedAt,
      emptyReason
    }
  }
}
```

`translationArticle` is the default history detail reading view. `sourceTranscript`
preserves the recognized source-language text without translation or local
rewriting. Partial live transcript chunks are excluded unless they were
finalized during turn completion, Stop, or session finalization.

## `PUT /api/sessions/:sessionId`

Persists a live Session snapshot. The request body is JSON:

```json
{
  "session": {
    "id": "session-id",
    "status": "active",
    "failureDiagnostics": []
  },
  "transcriptItems": []
}
```

`session.id` must match the path parameter. `transcriptItems` may contain only
newly finalized transcript items; the server appends them idempotently by item
id and updates session metadata/status from the `session` object. This supports
incremental long-session syncing, so Stop does not need to resend the complete
transcript item list.

`failureDiagnostics` is an optional array containing the latest safe connection
failure summaries. The server keeps at most the most recent 10 entries. Each
entry may include `at`, `source`, `stage`, `reason`, `category`, `code`,
`status`, `connectionEpoch`, `liveSessionId`, `segmentId`, and audio transport
counters. Tokens, API keys, authorization values, stack traces, and raw provider
messages are not persisted. The array is returned in Session detail, but not in
the history list response.

The default request limit for this route is `25MB`. `SESSION_SNAPSHOT_MAX_BYTES`
can override it. Oversized requests return `413 request_too_large`.

When finalized WAV audio artifacts were persisted, Session detail includes
download metadata:

```js
{
  audioArtifacts: {
    input: {
      kind: "input",
      mimeType: "audio/wav",
      byteLength,
      fileName,
      createdAt,
      downloadUrl
    },
    translation: {
      kind: "translation",
      mimeType: "audio/wav",
      byteLength,
      fileName,
      createdAt,
      downloadUrl
    }
  }
}
```

`input` exists only when the user enabled original speaker recording and the
artifact uploaded successfully. `translation` exists when translated audio was
produced and uploaded successfully. Storage paths are never exposed.

## `POST /api/sessions/:sessionId/audio/:kind`

Uploads one finalized WAV audio artifact for a Session. `kind` must be `input`
or `translation`. The request body is binary `audio/wav`; `X-File-Name` may
provide the browser-generated download filename. Empty bodies, unsupported
kinds, unsupported content types, and oversized bodies are rejected.

The endpoint updates the SessionRecord `audioArtifacts` metadata and returns the
public artifact metadata with its download URL. Upload failures do not affect the
Live API session or transcript persistence.

## `POST /api/sessions/:sessionId/audio/:kind/segments/:segmentIndex`

Uploads one ordered WAV segment for long Session audio. `segmentIndex` is a
zero-based integer. Each request is limited by `SESSION_AUDIO_MAX_BYTES`, which
defaults to `50MB`.

The server stores segmented artifact metadata as a manifest under
`audioArtifacts[kind]`. Public DTOs expose segment indexes, byte lengths, and
timestamps, but never storage paths. Re-uploading the same `segmentIndex`
replaces that segment's manifest entry.

## `GET /api/sessions/:sessionId/audio/:kind`

Downloads one persisted Session audio artifact as `audio/wav`. Legacy single
artifacts are returned directly. Segmented artifacts are composed from their
manifest into one WAV response, preserving the existing one-click download URL.
Missing Sessions or missing artifacts return `404 session_not_found`.

The detailed session-scoped history is also available from `GET
/api/sessions/:sessionId/translations`, optionally filtered by an allowlisted
`targetLanguageCode`. Source-language detection is exposed there as canonical
`sourceLanguageDetections`; it may contain multiple detected language codes.
If this history read fails while loading Session detail, the main Session detail
response remains available; history is an isolated read enhancement.

## `DELETE /api/sessions/:sessionId/translations/:outputId`

Deletes one completed formal saved-session retranslation output attached to the
identified Session. The endpoint deletes only the derived `TranslationOutput`;
it does not delete the source Session, canonical source transcript,
TranslationRequest, TranslationExecution, live-session primary output, active
Live API session, or provider state.

Successful deletion returns:

```json
{ "deleted": true, "sessionId": "session-1", "outputId": "output-1" }
```

Missing outputs, outputs owned by another Session, and live-session primary
outputs return `404 translation_output_not_found`. Malformed identifiers return
`400 invalid_request`.

## `DELETE /api/sessions/:sessionId`

Deletes one finalized Session history record, its related transcript items, and
any persisted audio artifacts. When the Session belongs to a Meeting, deletion
is Meeting-scoped: all finalized Session records, Meeting Segments, transcript
checkpoints, audio artifacts, and Meeting Recorder shares are deleted together.
The endpoint rejects deletion while the Meeting or any related Session is active.
Sessions without a `meetingId` retain the legacy single-Session behavior.

Successful deletion returns:

```json
{ "deleted": true, "sessionId": "session-1" }
```

For a Meeting-linked Session, the response also includes the cascade summary:

```json
{
  "deleted": true,
  "sessionId": "session-1",
  "meetingId": "meeting-1",
  "deletedSessionCount": 2,
  "deletedSegmentCount": 2
}
```

Missing records and non-finalized records return `404 session_not_found`.
Active Meeting-linked records return `409 meeting_delete_active_not_allowed`.
Malformed session identifiers return `400 invalid_request`.

## Access control

Private `/api/*` routes require `Authorization: Bearer <supabase-access-token>`.
The same Supabase access token is used for HTTP and execution-events WebSocket authentication.
Supabase validation checks signature, issuer, audience, expiry, the
`authenticated` role, and `AUTH_ALLOWED_EMAIL_DOMAINS`, returning fixed
`401 auth_required`, `401 auth_invalid`, or `403 auth_forbidden` errors.
`GET /api/profile` returns only the current user's profile. With
`P1_PROFILE_ONLY=true`, unimplemented capabilities return
`503 cloud_capability_unavailable`.

## `GET /api/metrics`

Returns the process-local translation queue reliability snapshot. The route is
private and requires the same access token and origin checks as other private
`/api/*` routes. Metrics reset when the server process restarts.

```json
{
  "metrics": {
    "translation_queue_depth": 0,
    "translation_queue_processed_total": 0,
    "translation_queue_skipped_total": 0,
    "translation_queue_cancelled_total": 0,
    "translation_queue_retry_total": 0,
    "translation_queue_failed_total": 0,
    "translation_queue_dlq_transfer_total": 0,
    "translation_queue_recovery_total": 0,
    "translation_queue_lease_error_total": 0,
    "translation_queue_acknowledgement_error_total": 0,
    "translation_queue_last_success_at": null
  },
  "generatedAt": "2026-08-10T00:00:00.000Z",
  "requestId": "request-id"
}
```

The endpoint is read-only and does not wake or process the translation worker.
It does not expose execution IDs, request IDs, provider keys, or provider error
messages.

## `POST /api/live-token`

Creates a short-lived Gemini ephemeral token for one browser Live Translate
session.

The authenticated browser sends its lifecycle-memory-only Gemini API Key in this
request. The backend uses it only for this request to create the token and never
persists or logs it. The response must not expose `GEMINI_API_KEY`.

## Request Body

```json
{
  "geminiApiKey": "<user-supplied-key>",
  "targetLanguageCode": "en",
  "sourceLanguageCode": "zh-Hant",
  "echoTargetLanguage": true,
  "meetingId": "meeting-1",
  "sessionId": "session-1",
  "segmentId": "segment-2"
}
```

Fields:

- `geminiApiKey`: Required request-scoped user credential. It must not be stored
  in localStorage, sessionStorage, cookies, Supabase, Vercel KV, server globals,
  logs, or any other persistent store.
- `targetLanguageCode`: Optional string. Defaults to `en`.
- `sourceLanguageCode`: Optional string. Defaults to `zh-Hant`. This is a soft
  primary input-language hint for model context; it does not prevent mixed
  speech and is not sent as `translationConfig.sourceLanguageCode`.
- `echoTargetLanguage`: Optional boolean. Defaults to `true`.
- `meetingId`: Optional Meeting identifier. When provided, the token uses the
  Meeting's saved glossary snapshot instead of the global live glossary.

## Response Body

```json
{
  "token": "ephemeral-token-name",
  "expiresAt": "2026-07-06T08:30:00.000Z",
  "liveConnectModel": "gemini-3.5-live-translate-preview",
  "liveConnectConfig": {
    "responseModalities": ["AUDIO"],
    "inputAudioTranscription": {},
    "outputAudioTranscription": {},
    "generationConfig": {
      "translationConfig": {
        "targetLanguageCode": "en",
        "echoTargetLanguage": true
      }
    },
    "systemInstruction": {
      "parts": [
        {
          "text": "Primary input language hint: zh-Hant. ..."
        }
      ]
    }
  },
  "liveGlossaryEntries": [
    {
      "source": "microphone",
      "target": "Alan speak",
      "replacementAliases": ["mic"]
    }
  ],
  "effectiveGlossaryRevision": "<sha256-hex>",
  "glossaryEntryCount": 1,
  "authoritativeSegment": {
    "meetingId": "meeting-1",
    "sessionId": "session-1",
    "segmentId": "segment-2",
    "lifecycleVersion": 8
  }
}
```

Fields:

- `token`: Gemini ephemeral token name returned by the provider.
- `expiresAt`: ISO timestamp matching the configured token expiration.
- `liveConnectModel`: Gemini Live model the browser must use with the
  backend-issued ephemeral token.
- `liveConnectConfig`: Browser Live API connect config matching the server-side
  token constraints. It includes the soft primary input-language hint in
  `systemInstruction`; when live-scoped glossary entries exist, they share that
  same instruction.
- `liveGlossaryEntries`: The Segment-immutable provider glossary entries resolved for the
  requested target language. They seed browser correction only when no
  independently refreshed correction snapshot exists. Translated audio follows
  the server-provided Gemini glossary instruction and is not post-processed by
  the browser.

Lifecycle v2 Meeting token requests require `sessionId` and `segmentId`, plus
the active recorder Session/Segment/lease/fence/lifecycle-version headers. The
server validates that binding against the authoritative active Segment returned
by Resume; client-supplied Segment identity is never authoritative.

`effectiveGlossaryRevision` is the deterministic SHA-256 of the versioned
`effective-glossary-v1` canonical payload: source language, target language,
normalized source/target terms, sorted aliases, and the merged effective Global
+ Meeting glossary. `liveConnectConfig.systemInstruction` and
`liveGlossaryEntries` are generated from the same provider snapshot. The
response also returns `glossaryEntryCount` and the authoritative
Meeting/Session/Segment/lifecycle-version identity. The browser must reject a
provider Segment or revision mismatch before opening Gemini. Local canonical
Cue correction separately reloads the effective Global + Meeting glossary via
the existing read APIs, computes the same deterministic format as
`correctionGlossaryRevision`, and binds that snapshot to each new Turn without
requiring a token request, provider reconnect, or Segment transition.

## Validation Rules

- `targetLanguageCode` must be in the supported language allowlist.
- `sourceLanguageCode` must be in the supported language allowlist when
  provided.
- `echoTargetLanguage` defaults to `true` when omitted.
- Invalid JSON returns `400`.
- Oversized request bodies return `413`.
- Missing request `geminiApiKey` returns `500` with `server_misconfigured`.
- Gemini token creation failures return `502`.

Supported language codes:

- `en`
- `ja`
- `ko`
- `zh-Hant`
- `zh-Hans`
- `es`
- `fr`
- `de`

## Error Responses

Invalid language:

```json
{
  "error": "Unsupported targetLanguageCode"
}
```

Missing request key:

```json
{
  "error": "server_misconfigured"
}
```

Provider failure:

```json
{
  "error": "Failed to create Gemini ephemeral token"
}
```

Unknown route:

```json
{
  "error": "Not found"
}
```

## Gemini Live API Event Handling

The frontend handles Gemini Live API events after opening a direct browser
session with the backend-issued ephemeral token.

TODO: Confirm exact event names and payload fields against the current Gemini
Live API SDK before implementation changes. The sections below define the
intended app-level event contract, not a guaranteed SDK type mapping.

## Input Transcript Event

Purpose: update the visible source transcript.

Expected app-level payload:

```json
{
  "text": "Recognized source speech",
  "isFinal": false
}
```

Handling requirements:

- Replace cumulative partial updates and append non-cumulative fragments to the
  open provider Turn, rather than treating each fragment as a new subtitle.
- Keep one pending bilingual Cue for the Turn until `turnComplete`,
  `generationComplete`, or the transcript-idle fallback finalizes it.
- If a transcript arrives after the boundary, preserve the boundary's final
  status and finalize the Cue once its source/translation counterpart arrives.
- Preserve final transcript text after the event is marked final.
- Ignore empty transcript updates.

TODO: Confirm whether Gemini marks input transcript segments as partial/final and
which field carries that status.

## Output Transcript Event

Purpose: update the visible translated transcript.

Expected app-level payload:

```json
{
  "text": "Translated speech",
  "isFinal": false
}
```

Handling requirements:

- Replace cumulative partial updates and append non-cumulative fragments to the
  open provider Turn, rather than treating each fragment as a new subtitle.
- Keep one pending bilingual Cue for the Turn until `turnComplete`,
  `generationComplete`, or the transcript-idle fallback finalizes it.
- If a transcript arrives after the boundary, preserve the boundary's final
  status and finalize the Cue once its source/translation counterpart arrives.
- Preserve final translated transcript text after the event is marked final.
- Keep source and translated transcript displays independently updateable.

TODO: Confirm whether Gemini marks output transcript segments as partial/final
and which field carries that status.

## Output Audio Event

Purpose: play translated audio returned by Gemini.

Expected app-level payload:

```json
{
  "audio": "base64-pcm16-audio",
  "mimeType": "audio/pcm;rate=24000"
}
```

Handling requirements:

- Decode base64 audio bytes.
- Treat output audio as raw PCM16 little-endian mono at 24kHz unless the SDK
  payload states otherwise.
- Schedule playback in order.
- Drop or stop playback when the user stops the session.

TODO: Confirm exact Gemini output audio payload field names and MIME metadata.

## Session Error Event

Purpose: recover from an unrecoverable Live API session failure.

Expected app-level payload:

```json
{
  "message": "Session error message",
  "code": "provider-or-client-code"
}
```

Handling requirements:

- Stop microphone tracks.
- Close or discard the Gemini session.
- Stop pending audio playback when appropriate.
- Move frontend state to `error`.
- Show a retry path.

TODO: Confirm exact SDK error event shape and whether close events include error
metadata.

## Account management and meeting membership

`PATCH /api/admin/users/:userId/role` accepts only `{ "role": "member" }` or `{ "role": "super_admin" }`. It returns `{ "user": <profile>, "changed": true|false }`. Stable role errors are `invalid_account_role`, `account_not_found`, `cannot_demote_self`, and `last_super_admin`; authentication continues to use `auth_required` and `auth_forbidden`. The server derives the actor from the authenticated request. Role mutation and its successful audit row are committed atomically by `update_account_role`; same-role submissions return `changed=false` and do not create role-change audit events.

Authorization resolves `actorUserId` from the authenticated request and `ownerUserId` from the meeting/session resource before repository access; active super-admins use the resource owner scope. A domain-approved pending profile is activated by the trusted backend before private dispatch. Disabled profiles receive `403 auth_forbidden`.

Private APIs refresh the server-side profile on every request. Disabled profiles receive `403 auth_forbidden`. Members must provide `meetingId` when creating a session and must have an active membership for that meeting; missing meetings and memberships return `403 recorder_forbidden`.

`GET/POST /api/meetings/:meetingId/members` and `DELETE /api/meetings/:meetingId/members/:userId` are restricted to the meeting owner or an active `super_admin`. Admin user listing and enable/disable endpoints require an active `super_admin`; disable requests require `{ "transferToUserId": "<active-user-id>" }`.

Successful and failed invite, remove, enable, disable, and transfer operations write safe audit records. Audit records never contain tokens, API keys, credentials, audio, transcript, cue text, or secrets. Transfer is atomic across owner-scoped meeting, transcript, translation, glossary, summary, audio, export, share, queue, DLQ, lease, and event assets. The removed credential store is not part of account transfer.

## Domain auto-activation access gate

After the backend verifies the Supabase JWT and exact `AUTH_ALLOWED_EMAIL_DOMAINS` match, it invokes the service-role-only `activate_pending_profile` RPC. The RPC performs only `pending -> active`, preserves role, and returns the current profile when a concurrent operation already changed it. New and existing pending profiles therefore enter the application without administrator approval. Missing profiles or failed activation return `503`; disabled profiles remain `403 auth_forbidden`. `POST /api/admin/users/:id/approve` is removed. Administrator `active -> disabled` and `disabled -> active` controls remain available.

## Session End Event

Purpose: clean up local resources after the Live API session ends.

Expected app-level payload:

```json
{
  "reason": "user-stopped"
}
```

Handling requirements:

- Stop microphone tracks.
- Close audio processing resources.
- Move frontend state to `stopped` when the end is expected.
- Move frontend state to `error` when the end is unexpected.

TODO: Confirm exact SDK session close/end event names.

## Transcript Polishing Translation Commands

`POST /api/translation-outputs` accepts a source transcript snapshot for the
final output. Its default JSON request limit is `25MB`, configurable with
`TRANSLATION_OUTPUT_MAX_BYTES`. Other translation command routes retain the
default `10KB` JSON request limit. Oversized requests return
`413 request_too_large`.

Transcript polishing reuses `POST /api/translation-requests` and
`POST /api/translation-executions`. A polishing request sets
`operation: "transcript_polishing"` and includes `segmentRange`, `inputHash`,
`model`, and a `sourceTranscriptSnapshot.refinementItems` array containing the
current finalized Cue plus up to two preceding Cues. The execution remains
asynchronous and returns `202`.

The existing `POST /api/translation-executions/:executionId/retry` endpoint is
used for failed polishing executions. Session detail translation history
includes completed polishing outputs with `operation`, `segmentRange`,
`inputHash`, `model`, completion timestamps, and `refinedItems`. Each item
contains `cueId`, `sequence`, `version`, `inputHash`, `refinedSource`, and
`refinedTranslation`. Clients apply only the current Cue item after version
validation; context Cues are never updated.

Current transcript polishing uses a structured source-and-translation result.
Failed executions retain safe provider
diagnostics (`status`, provider code/status/message, model, and config field
names) without prompt text, transcript content, API keys, or tokens.
## Application login audit event

`POST /api/auth-events` accepts `{ "event": "login" }` with a Supabase bearer token. The server performs the same trusted pending-profile activation, then writes `auth_login` with `result: success` for active profiles or `result: failure` for disabled profiles. The endpoint is rate-limited and origin-checked, returns `202` after a best-effort audit write, and never records provider-level OAuth failures without a safe actor identity.
## GSK-04 Live credential boundary

Current implementation supersedes any earlier Live-token credential wording in this document: `POST /api/live-token` requires the authenticated recorder request to provide `geminiApiKey`. It does not resolve `/api/profile/gemini-credential`, `gemini_credentials`, or `GEMINI_API_KEY` from the environment. The request key is not persisted or returned, and successful and error responses use `Cache-Control: no-store`.

The former profile credential API, `geminiCredentialApiClient`, and
`gemini_credentials` store are removed from the current implementation.
Existing user keys are not migrated to another persistent location. Rollback is
possible by reverting the application deployment before cleanup; after removal,
recovery requires a new request-scoped key. Non-Live backend Gemini workflows
may use an isolated environment key through their own provider composition; it
is not shared with recorder requests. Logs, metrics, telemetry, and audit
records must not contain API keys, ephemeral tokens, stored credentials,
request keys, or secret-bearing payloads.
