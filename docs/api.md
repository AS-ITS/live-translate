# Live Translate API and Events

## Execution Control

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
formal output version by `(sessionId, targetLanguageCode)`.

Translation history responses include `translationHistory.outputs` for formal
completed outputs and `translationHistory.executions` for executions without an
output. Formal output versions are scoped to `(sessionId, targetLanguageCode)`
and are ordered by completion time, newest first.

`GET /api/sessions/:sessionId` includes this compact read model when the
translation-history read succeeds:

```js
{
  translationHistory: {
    outputs: [
      {
        id,
        executionId,
        requestId,
        translatedText,
        targetLanguageCode,
        version,
        completedAt,
        source: 'formal'
      }
    ],
    executions: [
      {
        id,
        requestId,
        targetLanguageCode,
        status // queued | processing | failed
      }
    ]
  }
}
```

The detailed session-scoped history is also available from `GET
/api/sessions/:sessionId/translations`, optionally filtered by an allowlisted
`targetLanguageCode`. Source-language detection is exposed there as canonical
`sourceLanguageDetections`; it may contain multiple detected language codes.
If this history read fails while loading Session detail, the main Session detail
response remains available; history is an isolated read enhancement.

## `POST /api/live-token`

Creates a short-lived Gemini ephemeral token for one browser Live Translate
session.

The backend uses `GEMINI_API_KEY` server-side to create the token. The response
must not expose `GEMINI_API_KEY`.

## Request Body

```json
{
  "targetLanguageCode": "en",
  "echoTargetLanguage": true
}
```

Fields:

- `targetLanguageCode`: Optional string. Defaults to `en`.
- `echoTargetLanguage`: Optional boolean. Defaults to `true`.

## Response Body

```json
{
  "token": "ephemeral-token-name",
  "expiresAt": "2026-07-06T08:30:00.000Z"
}
```

Fields:

- `token`: Gemini ephemeral token name returned by the provider.
- `expiresAt`: ISO timestamp matching the configured token expiration.

## Validation Rules

- `targetLanguageCode` must be in the supported language allowlist.
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

- Append or replace partial source transcript text according to SDK payload
  semantics.
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

- Append or replace partial translated transcript text according to SDK payload
  semantics.
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
