# Live Translate API and Events

## Authenticated execution WebSocket

`WS /api/sessions/:sessionId/execution-events` streams execution status for one
Session. The first message must be
`{"type":"auth","token":"<DEMO_ACCESS_TOKEN>"}`; invalid or missing
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
timeline, final checkpoint transcript items, and article-style reading content.
Transcript items are ordered by Segment sequence and chunk time while retaining
Segment identity and status metadata.

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

Creates one active Meeting with its first active Segment. This endpoint is the
minimal backend entry point for checkpoint persistence; it does not start,
stop, reconnect, or segment a Gemini Live session. The optional
`liveSessionId` request field associates the first Segment with the frontend's
first Gemini Live connection.

```json
{ "liveSessionId": "live-session-1" }
```

Returns `201 Created`:

```json
{
  "meeting": { "id": "meeting-1", "status": "active" },
  "segment": { "id": "segment-1", "meetingId": "meeting-1", "sequence": 0, "status": "active" }
}
```

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
Cues merged from all persisted Segments and sorted by `sequence`. Partial Cue
checkpoint state is never exposed through this read model; legacy transcript
fields remain available for backward compatibility.

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
  "session": { "id": "session-id", "status": "active" },
  "transcriptItems": []
}
```

`session.id` must match the path parameter. `transcriptItems` may contain only
newly finalized transcript items; the server appends them idempotently by item
id and updates session metadata/status from the `session` object. This supports
incremental long-session syncing, so Stop does not need to resend the complete
transcript item list.

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
resolves the SessionRecord associated with the Meeting and serves its persisted
`input` or `translation` artifact. Missing Meetings or missing artifacts return
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
any persisted audio artifacts. The endpoint is intended for history consumers
only; it does not affect any active Live API session, microphone resource, token
flow, language preference, or current transcript state.

Successful deletion returns:

```json
{ "deleted": true, "sessionId": "session-1" }
```

Missing records and non-finalized records return `404 session_not_found`.
Malformed session identifiers return `400 invalid_request`.

## Access control

Private `/api/*` routes require `Authorization: Bearer <DEMO_ACCESS_TOKEN>`.
The legacy `X-Demo-Access-Token` header remains accepted for compatibility.
Production returns `503 auth_not_configured` when `DEMO_ACCESS_TOKEN` is absent;
development and test remain permissive when it is absent. Health/readiness and
Viewer share routes (`GET /api/shared-sessions/:token` and `/events`) remain
anonymous. Private requests also retain the configured origin check.

The browser uses the build-time `VITE_DEMO_ACCESS_TOKEN`. It must match the
server token and is visible in the frontend bundle; this v1 design does not
provide per-user security. All authenticated users share the same private API
permissions.

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

Updates Session metadata or lifecycle status. Supported statuses are `created`,
`active`, `paused`, `stopped`, `failed`, and `expired`; invalid transitions are
rejected.

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

The backend uses `GEMINI_API_KEY` server-side to create the token. The response
must not expose `GEMINI_API_KEY`.

## Request Body

```json
{
  "targetLanguageCode": "en",
  "sourceLanguageCode": "zh-Hant",
  "echoTargetLanguage": true
}
```

Fields:

- `targetLanguageCode`: Optional string. Defaults to `en`.
- `sourceLanguageCode`: Optional string. Defaults to `zh-Hant`. This is a soft
  primary input-language hint for model context; it does not prevent mixed
  speech and is not sent as `translationConfig.sourceLanguageCode`.
- `echoTargetLanguage`: Optional boolean. Defaults to `true`.

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
  ]
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

## Validation Rules

- `targetLanguageCode` must be in the supported language allowlist.
- `sourceLanguageCode` must be in the supported language allowlist when
  provided.
- `echoTargetLanguage` defaults to `true` when omitted.
- Invalid JSON returns `400`.
- Oversized request bodies return `413`.
- Missing `GEMINI_API_KEY` returns `500`.
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

Missing API key:

```json
{
  "error": "GEMINI_API_KEY is not configured"
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

Transcript polishing reuses `POST /api/translation-requests` and
`POST /api/translation-executions`. A polishing request sets
`operation: "transcript_polishing"` and includes `segmentRange`, `inputHash`,
`model`, and a `sourceTranscriptSnapshot.polishingItems` array containing only
paired final Cue data. The execution remains asynchronous and returns `202`.

The existing `POST /api/translation-executions/:executionId/retry` endpoint is
used for failed polishing executions. Session detail translation history
includes completed polishing outputs with `operation`, `segmentRange`,
`inputHash`, `model`, `version`, completion timestamps, and `polishedItems`.
Each item contains `cueId`, `sequence`, and `polishedText`. Clients render these
items through an independent `polishedArticle` field; they must not merge them
into `cues`, `sourceTranscript`, `translationArticle`, session transcript
items, or the Live prompt. Legacy outputs containing source-polishing fields
are ignored for canonical field replacement.

Current transcript polishing uses one plain-text provider result. The result is
returned through the existing `translatedText` output field and does not use
structured-output configuration. Failed executions retain safe provider
diagnostics (`status`, provider code/status/message, model, and config field
names) without prompt text, transcript content, API keys, or tokens.
