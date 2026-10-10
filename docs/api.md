# Live Translate API and Events

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

## Phase 0 delivery and permission contract, 2026-10-01

The browser is the sole reader of page OPFS. It explicitly sends immutable
audio chunks to the local service; the service cannot directly read page OPFS,
IndexedDB, or other page storage. This path is distinct from the direct
browser-to-Gemini connection.

The browser has durable pending queues for `cue`, `checkpoint`, `operation`,
and `audio`. Audio queue entries reference immutable OPFS chunks and retain
sequence, byte range, checksum, and retry metadata. A successful ACK requires
durable commit of the matching idempotency key and version. Missing ACKs are
resent with the same key, duplicate delivery returns the original result, and
stale fence/version/hash requests return a structured conflict without
overwriting newer state.

Recovery order is queue validation/checksum, lifecycle operations in sequence,
dependent checkpoints and Cues in version order, then audio chunks in chunk
order. Queues ACK independently. Local Supabase on the recording device is the
only recording lifecycle owner. Cloud Supabase stores only accounts,
permissions, meeting settings, dictionaries, and device/meeting entry data;
it is not the recording-data owner. Browser queues never create their own
Meeting/Session/Segment state.

Viewer shares grant sanitized read-only access only. Host export permission is
authenticated and checked separately, never inferred from a share token. Stop
immediately revokes Viewer and Recorder shares; the host can export TXT/SRT/VTT
and download completed audio for 30 minutes, after which content returns
`410 meeting_content_expired`.

Origin/CORS is allowlist-only for approved Preview and Production origins.
There is no wildcard or arbitrary localhost approval in the deployed contract.

Failed, skipped, or environment-blocked checks must be reported as such and
cannot be labelled `baseline passed`. Phase 1 physical acceptance remains
pending for Mac/Windows microphones, reload/crash recovery, OPFS quota/offline
resend, audio loss/recovery, and Preview/Production Origin/CORS.

## Meeting recording lifecycle v2 (Issue #37 Phase 1)

New Meetings use a Supabase-owned lifecycle. Vercel Functions only validate the
request and invoke a transactional RPC; they do not retain recorder state.

```http
POST /api/meetings/:meetingId/recording/start
POST /api/meetings/:meetingId/recording/pause
POST /api/meetings/:meetingId/recording/resume
POST /api/meetings/:meetingId/recording/rollover
POST /api/meetings/:meetingId/recording/recover
POST /api/meetings/:meetingId/recording/stop
POST /api/meetings/:meetingId/recording/takeover
POST /api/meetings/:meetingId/recording/lease/heartbeat
POST /api/meetings/:meetingId/heartbeat
```

Lifecycle mutations carry `operationId`, `expectedLifecycleVersion`, and—after
`start`—`leaseId` plus `fenceToken`. Repeating the same operation returns its
stored result. A stale lifecycle version or competing transition returns
`409 meeting_lifecycle_conflict`. Other stable conflict codes are
`recorder_already_active`, `recorder_lease_invalid`, and
`recorder_takeover_confirmation_required`.

The recorder renews its 10-second Meeting lease every 3 seconds. The same
principal may take over an expired lease; a different principal requires an
owner or super-admin force takeover with explicit confirmation. Provider
reconnect does not create a Segment. Pause/resume, rollover, and browser-crash
recovery do.

Successful completion alone freezes the database-generated `ended_at` and
`purge_at = ended_at + 30 minutes` for one Meeting recording, including all
rollover Sessions/Segments. Pause, reconnect, interruption, and stale-heartbeat
handling do not start retention. Old records without a reliable completion
anchor are not bulk-deleted. Direct authenticated Supabase table/Storage reads
and late writes are restricted by RLS and triggers; signed download URLs are
clipped to the remaining retention window.

At expiry, `GET /api/meetings/:meetingId` remains `200` with settings,
`contentState: "expired"`, `expiresAt`, no recording content, and a separate
`physicalCleanupState`. Viewer snapshot/replay/token, audio and export
download/content routes return `410 meeting_content_expired`. The Meeting,
settings, members, glossary, and audit history stay. Existing Meeting GETs
trigger managed `waitUntil` cleanup: one Meeting per request, at most 20
Storage objects or 50 DB rows, a persistent 15-second cross-instance throttle,
and resumable claims. Cleanup errors do not alter Meeting completion or the
HTTP read response. No Cron is configured. Without API traffic, cloud physical
data may remain after 30 minutes until a later request.

Completed or failed lifecycle v2 Meetings return `409 meeting_terminal` for
new recording lifecycle commands and reject new Session, Segment, Viewer-share,
or finalized Cue writes. For v2 Meetings, finalized transcript data is stored
only in `subtitle_cues`; compatibility Session snapshots do not append
`transcript_items`.

`POST /api/meetings/:meetingId/segments/:segmentId/audio-uploads` requires the
current `X-Meeting-Session-Id`, `X-Meeting-Segment-Id`,
`X-Meeting-Lease-Id`, and `X-Meeting-Fence-Token` headers before it creates an
artifact. An artifact created before terminal transition may still complete or
fail before `purge_at`; completion and failure at or after that deadline return
`409 meeting_terminal`.

## Meeting Viewer snapshot pagination

`GET /api/shared-meetings/:token` and
`GET /api/shared-meetings/code/:shortCode` return the newest 100 finalized Cues
by default. The response includes `pagination.hasMore` and an opaque
`pagination.nextCursor`; pass that value as `?before=<cursor>` to load the
previous page. `limit` may be set from 1 through 100.

The response also includes authoritative `recordingState`: `waiting`, `active`,
`paused`, `recovering`, or `ended`. Viewer clients treat only `ended` (or a
terminal share/API error) as Meeting termination. `paused` and `waiting` use
bounded lifecycle polling and do not consume WebRTC recovery attempts.

Viewer reads use one bounded joined Cue query in cloud mode. They do not load
all Segments or expose Meeting glossary, private settings, audio metadata, or
live session identifiers. Cursor pages are merged by `cueId` and ordered by
Segment sequence plus Cue sequence, so Realtime delivery remains idempotent.

## Meeting export lifecycle (P7)

Assigned members can read the meeting data explicitly covered by RLS and can
write recording data only while active with `can_record=true`. They cannot
modify owner settings, membership/share state, glossary data, exports, or
delete the meeting. Export and signed audio download URLs remain owner-scoped.

Supabase cloud mode provides owner-only asynchronous Meeting export endpoints:

```http
POST /api/meetings/:meetingId/exports
Content-Type: application/json

{"format":"txt","stream":"translation"}
```

`format` is `txt`, `srt`, or `vtt`; `stream` is `source`, `translation`, or
`both`. `srt` and `vtt` reject `both` with `400 export_invalid_stream`. A
successful request returns `202` and an export artifact with `queued` status.

```http
GET  /api/meetings/:meetingId/exports
GET  /api/meetings/:meetingId/exports/:exportId
POST /api/meetings/:meetingId/exports/:exportId/download-url
DELETE /api/meetings/:meetingId/exports/:exportId
```

Only `ready` artifacts produce a download URL. The URL expires after 60
seconds. The API never returns Storage paths, signed URLs in logs, transcript
text, JWTs, or Storage credentials. Local file-backed mode continues to use
the existing browser export path.

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

## Realtime subtitle pipeline contract

In cloud mode, execution status changes are persisted in Supabase and clients
subscribe through Supabase Realtime. REST execution snapshots remain the
authoritative recovery path after disconnects. The Vercel Cron worker processes
durable translation jobs in bounded batches and does not rely on process-local
polling.

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

`cueId`, `sessionId`, `segmentId`, `sequence`, time range, and language identity
define immutable Cue identity. Source or translation may initially be empty;
later versions update the same read-model row and never create a second Cue or
alter its ordering.
Consumers compute the effective translation as
`refinedTranslation → initialTranslation → legacy translatedText`.

### Execution trigger and operations

After a finalized Cue is submitted for checkpoint persistence, the frontend
creates an asynchronous initial translation execution using
`gemini-3.5-flash`. A successful initial translation then schedules a separate
refinement execution, also using Flash; both operations are non-blocking from
the Live transcription request. Failures are stored with safe status
information and are retryable without changing the Cue identity or source
fields.

Worker results must use structured output with the expected operation, exact
`cueId`, source/input hash, target language, and bounded text fields. Unknown
fields, missing required fields, mismatched Cue identity, invalid language, or
oversized output fail validation before persistence. Refinement context is
read-only; only the addressed Cue can be updated.

Duplicate submissions are idempotent by `cueId` plus operation/input version
and provider idempotency key. A same-Cue update is accepted only when its
expected version and input hash still match. Older or late worker output is
classified as stale and discarded without overwriting a newer translation or
refinement.

Legacy projections remain available for existing clients: `translatedText`
maps to the effective translation, `rawTranslation` maps to the initial/raw
translation where available, and `refinedTranslation` remains exposed as the
newer optional field. Existing auth, rate limiting, origin checks, structured
errors, backend-only `GEMINI_API_KEY`, and ephemeral-token secret isolation
remain unchanged.

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

### P3 Storage and Realtime override

The following cloud contract supersedes the older process-local SSE contract
below. `POST /api/meetings/:meetingId/segments/:segmentId/cues` persists a Final
Cue before a database trigger broadcasts `cue.append`. A Viewer exchanges its
share through `POST /api/shared-meetings/:token/realtime-token` (or the
short-code variant), subscribes to private `meeting:<meetingId>`, then merges a
REST snapshot. The share-scoped JWT expires in at most five minutes. Cloud SSE
returns `410 realtime_required`; it remains available only as a local fallback.

Original Segment audio uses metadata-only HTTP endpoints:

- `POST /api/meetings/:meetingId/segments/:segmentId/audio-uploads` returns the
  private Storage TUS endpoint/path for `{ mimeType, byteSize }`.
- `POST /api/meetings/:meetingId/audio-artifacts/:artifactId/complete` verifies
  the object; `/fail` records a failed upload.
- `POST /api/meetings/:meetingId/audio-artifacts/:artifactId/download-url`
  performs ownership validation and returns a 60-second signed URL with
  `Cache-Control: no-store`.

The Meeting-level Viewer capability is delivered incrementally. Existing
Session share and Meeting checkpoint routes remain the current implementation
contract for their respective resources.

Milestone 4 Meeting Viewer sharing is available through
`POST /api/meetings/:meetingId/shares` with
`{ "role": "viewer", "expiresAt": null }`. Anonymous Viewer reads use
`GET /api/shared-meetings/:token` or
`GET /api/shared-meetings/code/:shortCode`; the response contains sanitized
Meeting metadata and historical final Cues, but no glossary, audio artifact,
Recorder lease, device, or credential data. Live Cue events and reconnect
recovery are provided by the Milestone 5 SSE contract below.

Milestone 5 adds `POST /api/meetings/:meetingId/segments/:segmentId/cues` for
finalized Cue publication. Owner requests use the existing Access Token gate;
Recorder requests use the existing Recorder grant, lease, fence, and session
headers. The endpoint validates the Meeting／Segment／Session relationship,
publishes without waiting for checkpoint persistence, and returns the Meeting
event cursor.

Viewer SSE uses `GET /api/shared-meetings/:token/events` or the short-code
variant. The client may send `after=<eventId>` or rely on `Last-Event-ID`.
Requests with `Accept: application/json` return a bounded replay payload
`{ events, cursor, gap? }` instead of opening an SSE stream; the cloud Realtime
Viewer uses this form after subscribing. Events are process-local and replayable
only within the bounded in-memory history when the durable event repository is
unavailable. When an SSE cursor is too old, the stream emits `meeting.gap` and
the Viewer refetches the REST snapshot.

## Session sharing

Share creation accepts `role: "viewer" | "recorder"` and defaults to Viewer.
Recorder creation also returns a `recorderUrl`. Recorder lease claim,
heartbeat, and release are exposed at
`/api/shared-sessions/:token/recorder-lease` and its `/heartbeat` child route.
Only one active lease is allowed per Session; a duplicate claim returns
`409 recorder_already_active`.

Recorder shares always have a finite expiry (30 minutes by default when the
owner omits `expiresAt`). A successful claim returns `recorderGrant` and
`grantExpiresAt`. Recorder live-token, Session snapshot, and audio upload
requests use `X-Recorder-Token`, `X-Recorder-Grant`, `X-Recorder-Lease-Id`,
and `X-Recorder-Fence-Token`; checkpoint writes additionally use
`X-Recorder-Session-Id`. Invalid, expired, revoked, mismatched, or stale
credentials are rejected. Recorder snapshots cannot change Session metadata,
and Recorder clients cannot download Session audio.

Authenticated owner routes are available at `GET`/`POST /api/sessions/:sessionId/shares`
and `DELETE /api/sessions/:sessionId/shares/:shareId`. Creation returns a
one-time plaintext token and short code, plus legacy SPA hash URLs
(`#watch?token=...` and `#watch?code=...`); stored share metadata contains only
hashes. The legacy `#watch` frontend route is no longer exposed and falls back
to `#meetings`. Anonymous
Viewer reads and SSE streams resolve through either `/api/shared-sessions/:token`
or `/api/shared-sessions/code/:code` and their `/events` variants. Viewer detail
and SSE snapshots share the same sanitized DTO and never include audio or input
device metadata.

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

## Dead-letter queue administration

When durable translation queue storage is enabled, the shared Access Token
protects `GET /api/translation-dead-letter-queue` (full `{ items, size }`) and
`POST /api/translation-dead-letter-queue/:executionId/replay` (new queued
execution). The original failed execution and DLQ item are retained. Disabled
storage returns `503 dead_letter_queue_unavailable`; an unknown item returns
`404 dead_letter_item_not_found`.

## Long Meeting Checkpoints

## `GET /api/meetings`

Returns read-only Meeting history summaries. This endpoint does not create,
stop, recover, or mutate Live sessions.

```json
[
  {
    "id": "meeting-1",
    "status": "active",
    "startedAt": 1720000000000,
    "endedAt": null,
    "durationMs": null,
    "segmentSummary": {
      "totalSegments": 3,
      "countsByStatus": {
        "completed": 2,
        "active": 1
      },
      "hasInterruptedSegments": false,
      "hasFailedSegments": false
    },
    "transcriptSummary": {
      "totalItems": 12,
      "sourceFinalCount": 6,
      "translationFinalCount": 6,
      "hasTranscript": true
    },
    "failureInfo": null,
    "recordKind": "meeting"
  }
]
```

## `GET /api/meetings/:meetingId`

Returns one composed Meeting detail read model with ordered Segments, a Segment
timeline, final checkpoint transcript items, persisted Final Cues, and
article-style reading content. Transcript items are ordered by Segment sequence
and chunk time while retaining Segment identity and status metadata. `cues`
contains final bilingual subtitle Cues aggregated from Segment checkpoints and
is the preferred source for SRT/VTT export.

Missing Meetings return `404`.

```json
{
  "meeting": {
    "id": "meeting-1",
    "status": "active",
    "startedAt": 1720000000000,
    "endedAt": null,
    "durationMs": null,
    "segmentSummary": {
      "totalSegments": 2,
      "countsByStatus": {
        "interrupted": 1,
        "active": 1
      },
      "hasInterruptedSegments": true,
      "hasFailedSegments": false
    },
    "transcriptSummary": {
      "totalItems": 2,
      "sourceFinalCount": 1,
      "translationFinalCount": 1,
      "hasTranscript": true
    },
    "failureInfo": null,
    "recordKind": "meeting"
  },
  "segments": [
    {
      "id": "segment-1",
      "meetingId": "meeting-1",
      "sequence": 0,
      "status": "interrupted",
      "startedAt": 1720000000000,
      "endedAt": 1720000600000,
      "durationMs": 600000,
      "liveSessionId": "live-session-1",
      "errorInfo": {
        "reason": "token_expired",
        "category": "token"
      },
      "checkpointUpdatedAt": 1720000600000,
      "transcriptSummary": {
        "totalItems": 2,
        "sourceFinalCount": 1,
        "translationFinalCount": 1,
        "hasTranscript": true
      }
    }
  ],
  "timeline": [
    {
      "id": "segment-1",
      "sequence": 0,
      "status": "interrupted",
      "startedAt": 1720000000000,
      "endedAt": 1720000600000,
      "durationMs": 600000,
      "liveSessionId": "live-session-1",
      "errorInfo": {
        "reason": "token_expired",
        "category": "token"
      }
    }
  ],
  "transcriptItems": [
    {
      "id": "segment-1:source:1",
      "meetingId": "meeting-1",
      "segmentId": "segment-1",
      "segmentSequence": 0,
      "segmentStatus": "interrupted",
      "liveSessionId": "live-session-1",
      "stream": "source",
      "status": "final",
      "text": "confirmed source text",
      "sequence": 1,
      "startedAt": 1720000100000,
      "finalizedAt": 1720000100000
    }
  ],
  "cues": [
    {
      "cueId": "cue:session-1:segment-1:1",
      "sessionId": "session-1",
      "segmentId": "segment-1",
      "sequence": 1,
      "startTimeMs": 1000,
      "endTimeMs": 2800,
      "sourceLanguageCode": "zh-Hant",
      "targetLanguageCode": "en",
      "sourceText": "確認的原文。",
      "translatedText": "confirmed source text.",
      "status": "final",
      "finalizedReason": "turnComplete"
    }
  ],
  "readingContent": {
    "sourceTranscript": {
      "kind": "sourceTranscript",
      "status": "available",
      "text": "confirmed source text",
      "paragraphs": ["confirmed source text"]
    },
    "translationArticle": {
      "kind": "translationArticle",
      "status": "available",
      "text": "confirmed translation text",
      "paragraphs": ["confirmed translation text"]
    }
  },
  "recordKind": "meeting"
}
```

## `POST /api/meetings`

Creates a Meeting and its first Segment. Pass `draft: true` for the Meeting
Management flow; the Meeting and Segment remain `created` until a Recorder
explicitly starts. Existing internal checkpoint callers may omit `draft` and
retain the active Meeting behavior. This endpoint does not start, stop,
reconnect, or segment a Gemini Live session. The optional
`liveSessionId` request field associates the first Segment with the frontend's
first Gemini Live connection. `name`, `sourceLanguageCode`, and
`targetLanguageCode` store Meeting settings. `echoTargetLanguage` defaults to
`true` and `shouldRecordInputAudio` defaults to `false`. `glossaryEntries` stores the
selected shared-glossary snapshot for compatibility; `privateGlossaryEntries`
stores terms owned only by this Meeting.

```json
{
  "draft": true,
  "name": "產品會議",
  "sourceLanguageCode": "zh-Hant",
  "targetLanguageCode": "en",
  "echoTargetLanguage": true,
  "shouldRecordInputAudio": false,
  "glossaryEntries": [
    {
      "source": "Acme",
      "translations": { "en": "Acme", "ja": "アクメ" },
      "replacementAliases": { "en": ["ACME"] }
    }
  ],
  "privateGlossaryEntries": [
    {
      "source": "專案代號",
      "translations": { "en": "Project Codename" },
      "replacementAliases": { "en": ["代號"] }
    }
  ]
}
```

Returns `201 Created`:

```json
{
  "meeting": { "id": "meeting-1", "name": "產品會議", "status": "created" },
  "segment": { "id": "segment-1", "meetingId": "meeting-1", "sequence": 0, "status": "created" }
}
```

## `PATCH /api/meetings/:meetingId`
`privateGlossaryEntries[].replacementAliases` uses the canonical language-to-aliases object format. Legacy empty-array values (`[]`) are normalized to `{}`; non-empty arrays remain invalid.

Updates Meeting name, source/target languages, translated-audio playback,
original-audio recording, shared glossary entries, and
private glossary entries. A live Recorder applies changed language or glossary
settings at the next Segment boundary; provider reconnect within the current
Segment keeps its settings snapshot. Same-source private Meeting entries
override selected shared entries. Existing subtitles and already-played
provider audio are not rewritten. Completed Meetings are read-only and return
`409 meeting_settings_locked`.

## `DELETE /api/meetings/:meetingId`

The owner or active super-admin may delete a non-expired created or completed
Meeting. After the recording content expires, deletion is restricted to an
active super-admin. An active or otherwise resumable Meeting keeps its existing
`409` restriction. Deletion
removes Meeting-specific children and Storage objects but retains shared
glossary, accounts, credentials, audit history, and a protected minimal deletion
tombstone. Bounded Storage deletion may return `202 {"status":"deleting"}`;
retry the same DELETE until `204`. A repeat `204` is authorized using the
tombstone's original owner (or active super-admin), never deleted membership
rows. Another computer's OPFS is cleaned on its next successful sync or local
expiry check, not immediately by this API.

## `POST /api/meetings/:meetingId/complete`

Completes the Meeting only after the recording has successfully ended. The
backend/database returns one immutable 30-minute expiration shared by all
associated Sessions; repeated completion does not extend it. Cleanup is
independent of this command and cannot make completion fail or reset the
recorded deadline. Active recordings return `409 meeting_complete_not_allowed`.

## `GET|POST /api/meetings/:meetingId/shares`

Lists active Recorder shares or creates a Recorder share after Meeting settings
are saved. `POST` returns the opaque token and short-code URLs once; later list
responses contain metadata only. Completed Meetings keep existing shares
available for viewing, but `POST` returns `409 meeting_share_locked`.

## `DELETE /api/meetings/:meetingId/shares/:shareId`

Revokes one Meeting share. Existing Viewer shares may be revoked after a Meeting
is completed; completed Meetings still reject new share creation and settings
changes.

## `GET /api/meetings/:meetingId/segments`

Returns the Meeting's ordered segments.

```json
{
  "meetingId": "meeting-1",
  "segments": [
    { "id": "segment-1", "meetingId": "meeting-1", "sequence": 0, "status": "active" }
  ]
}
```

Missing Meetings return `404`.

## `POST /api/meetings/:meetingId/segments/:segmentId/rollover`

Completes the current active Segment with a final checkpoint and creates the
next active Segment in the same Meeting.

```json
{
  "idempotencyKey": "rollover:segment-1:live-session-2",
  "checkpoint": {
    "idempotencyKey": "checkpoint:segment-1:rollover",
    "durableChunks": [],
    "pendingPartial": null
  },
  "nextLiveSessionId": "live-session-2"
}
```

Returns `201 Created`:

```json
{
  "completedSegment": { "id": "segment-1", "meetingId": "meeting-1", "sequence": 0, "status": "completed" },
  "segment": { "id": "segment-2", "meetingId": "meeting-1", "sequence": 1, "status": "active", "liveSessionId": "live-session-2" }
}
```

Duplicate rollover requests with the same idempotency key and next Live session
association return the same next Segment. Conflicting duplicate rollover data
returns `409`. Missing Meetings or Segments return `404`; non-active current
Segments return `409`.

## `POST /api/meetings/:meetingId/segments/:segmentId/recover`

Marks the current active Segment as interrupted or failed with a final
checkpoint. Interrupted recovery creates the next active Segment in the same
Meeting for a fresh Live session association. Failed recovery terminalizes only
the current Segment.

```json
{
  "idempotencyKey": "recover:segment-1:live-session-2",
  "checkpoint": {
    "idempotencyKey": "checkpoint:segment-1:recover",
    "durableChunks": [],
    "pendingPartial": null
  },
  "nextLiveSessionId": "live-session-2",
  "failureReason": "token_expired",
  "failureCategory": "token",
  "outcome": "interrupted"
}
```

Interrupted recovery returns `201 Created`:

```json
{
  "interruptedSegment": { "id": "segment-1", "meetingId": "meeting-1", "sequence": 0, "status": "interrupted" },
  "segment": { "id": "segment-2", "meetingId": "meeting-1", "sequence": 1, "status": "active", "liveSessionId": "live-session-2" }
}
```

Failed recovery returns `201 Created`:

```json
{
  "failedSegment": { "id": "segment-1", "meetingId": "meeting-1", "sequence": 0, "status": "failed" }
}
```

Duplicate recovery requests with the same idempotency key, outcome, failure
metadata, and next Live session association return the same stored result.
Conflicting duplicate recovery data returns `409`. Missing Meetings or Segments
return `404`; non-active current Segments return `409`.

## `PUT /api/meetings/:meetingId/segments/:segmentId/checkpoint`

Persists confirmed transcript or translation chunks for one Segment.

```json
{
  "idempotencyKey": "checkpoint:segment-1:12",
  "durableChunks": [
    {
      "idempotencyKey": "segment-1:source:4",
      "meetingId": "meeting-1",
      "segmentId": "segment-1",
      "stream": "source",
      "sequence": 4,
      "text": "confirmed text",
      "timestamp": 1720000000000
    }
  ],
  "finalCues": [],
  "refinedSubtitleCues": [],
  "refinedSubtitleRevision": 0,
  "refinedSubtitleInputHash": null,
  "refinedSubtitleStatus": "pending",
  "pendingPartial": null
}
```

The backend stores only confirmed durable chunks. Duplicate chunk
`idempotencyKey` values with the same payload are accepted as idempotent
success. A duplicate chunk key or duplicate `stream + sequence` with different
content returns `409`. Chunks may arrive out of order; stored chunks are read
back sorted by stream and sequence. Completed or failed Segments reject
checkpoint updates with `409`.

## `GET /api/meetings/:meetingId/segments/:segmentId/checkpoint`

Returns the Segment checkpoint:

```json
{
  "meetingId": "meeting-1",
  "segmentId": "segment-1",
  "checkpoint": {
    "idempotencyKey": "checkpoint:segment-1:12",
    "durableChunks": [],
    "finalCues": [],
    "refinedSubtitleCues": [],
    "refinedSubtitleRevision": 0,
    "refinedSubtitleInputHash": null,
    "refinedSubtitleStatus": "pending",
    "pendingPartial": null,
    "updatedAt": 1720000000000
  }
}
```

Missing Meetings or Segments return `404`. Pending partial text is intentionally
not durable checkpoint content.

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

### `POST /api/translation-executions/:executionId/cancel`

Cancels the identified execution only when its current status is `queued`.
Success returns `200 OK` and the same execution with status `cancelled`.
`cancelled` is terminal and produces no TranslationOutput. This endpoint does
not accept a request body or client-controlled request, provider, status,
attempt, or idempotency metadata.

### `POST /api/translation-executions/:executionId/retry`

Manually retries the identified execution only when it is `failed`. Success
returns `202 Accepted` and a newly created `queued` execution. The source
execution remains failed; the new execution has a different ID, keeps the same
request identity and provider key, and receives a new provider idempotency
identity. This endpoint accepts no request body or client-controlled execution
metadata.

For both endpoints, an invalid execution ID returns `400`; a missing execution
or source request returns `404`; an ineligible status returns `409`; enqueue or
unexpected failures return a safe `500` error without internal details.

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

## `GET /api/meetings/:meetingId/audio/:kind`

Downloads the whole-meeting audio artifact for a Long Meeting. The backend
resolves all persisted SessionRecords associated with the Meeting, orders them by
Meeting Segment sequence, and composes their `input` or `translation` WAV payloads
into one download. Session-level segmented manifests are composed before the
Meeting-level composition. Missing Meetings or missing artifacts return
`404 session_not_found`.

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

## Session-first commands

### `POST /api/sessions`

Creates a persisted Session before a Gemini Live connection is opened. The
initial status is `created`. The request may include `name`,
`targetLanguageCode`, `sourceLanguageCode`, and input-device metadata.

### `PATCH /api/sessions/:sessionId`

Updates Session metadata, lifecycle status, or the current Meeting Segment
binding. Supported fields include `name`, `targetLanguageCode`,
`targetLanguageLabel`, `sourceLanguageCode`, and `segmentId`; supported statuses
are `created`, `active`, `paused`, `stopped`, `failed`, and `expired`, and invalid
transitions are rejected. During long-meeting rollover, the old Segment is
checkpointed and its queued Cues are published before the same Session is
rebound to the new `segmentId`; new Cues are accepted only after that binding
update succeeds. Existing Meeting, Session, and Segment authorization checks
remain in force.

### Sharing

- `POST /api/sessions/:sessionId/shares` creates an opaque share token.
- `DELETE /api/sessions/:sessionId/shares/:shareId` revokes a share.
- `GET /api/shared-sessions/:token` returns Viewer-safe Session detail.
- `GET /api/shared-sessions/:token/events` opens a read-only SSE stream.

Viewer detail excludes audio artifacts and browser input-device identifiers.
SSE event IDs are monotonic per Session and each event contains the latest
snapshot, allowing reconnect clients to render the latest known state.

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
- `liveGlossaryEntries`: The same live-scoped glossary entries resolved for the
  requested target language. The browser uses these for deterministic translated
  subtitle replacement. Translated audio follows the server-provided Gemini
  glossary instruction and is not post-processed by the browser.

Lifecycle v2 Meeting token requests require `sessionId` and `segmentId`, plus
the active recorder Session/Segment/lease/fence/lifecycle-version headers. The
server validates that binding against the authoritative active Segment returned
by Resume; client-supplied Segment identity is never authoritative.

`effectiveGlossaryRevision` is the deterministic SHA-256 of the versioned
`effective-glossary-v1` canonical payload: source language, target language,
normalized source/target terms, sorted aliases, and the merged effective Global
+ Meeting glossary. `liveConnectConfig.systemInstruction` and
`liveGlossaryEntries` are generated from that same snapshot. The response also
returns `glossaryEntryCount` and the authoritative Meeting/Session/Segment/
lifecycle-version identity. The browser must reject a Segment or revision
mismatch before opening Gemini or enabling local correction.

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
