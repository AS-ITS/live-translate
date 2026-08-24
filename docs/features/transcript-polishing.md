# Transcript Polishing

## Purpose

Transcript polishing refines each finalized bilingual Cue asynchronously while
Gemini Live Translate continues to produce the low-latency raw result. The raw
source and translation remain available for audit and export; refined values
are stored on the same Cue and become the default display/article/export text.

## Runtime Contract

Only paired, final Cue records are eligible. Partial or source-only Cues stay
in the Live transcript and are not sent to the polishing provider. Each Cue
creates one refinement request with the current Cue and up to two preceding
finalized Cues as context; only the current Cue may be updated.

The browser submits a non-blocking request after each finalized Cue. Request
identity is derived from `cueId`, refinement version, and raw input hash.

Requests use the existing TranslationRequest/TranslationExecution queue with
`operation: "transcript_polishing"`. The structured provider response contains
`refinedSource` and `refinedTranslation` addressable by Cue identity and
version. Completion updates the existing Cue only after the input hash/version
check succeeds. Delayed responses are ignored as stale.

Provider failures, timeouts, rate limits, and retries are isolated from the
Gemini Live session. Queue retry, backoff, durable recovery, and failure
metadata use the existing translation execution infrastructure.

The authoritative `TRANSCRIPT_POLISHING_MAX_RPM` gate is in the server
translation execution runner, immediately before each polishing provider
attempt. Every attempt, including retry attempts, consumes one slot. Waiting
for a slot is not a provider failure and does not enter the DLQ path. The
front-end coordinator may perform early throttling for responsiveness, but it
is not the authoritative provider limit.

## Configuration

```env
TRANSCRIPT_POLISHING_ENABLED=true
TRANSCRIPT_POLISHING_MODEL=gemini-3.5-flash-lite
TRANSCRIPT_POLISHING_MAX_RPM=15
TRANSCRIPT_POLISHING_TIMEOUT_MS=30000
```

The provider receives finalized source/translation context and returns both
refined source and translation. Its prompt requires preservation of meaning,
numbers, dates, names, terminology, negation, commitments, and glossary rules.
A provider failure leaves raw Cue content unchanged and remains retryable
through the existing execution flow. Provider attempts respect the configured
RPM limit and use existing timeout, retry, backoff, recovery, and DLQ paths.

The runner uses a sliding 60-second window and is process-local for the current
single-Node deployment. The durable queue preserves pending work across server
restart; the in-memory RPM window starts fresh after restart. Multi-process
shared limiting would require a separate capability.

The response is addressable by `cueId` and `sequence`; legacy outputs that only
contain translation text remain readable and do not change source text.
Provider failures retain safe diagnostics including HTTP status, provider
code/status, provider message, model, and config field names. Prompts and
transcript content are never included in those diagnostics.

Frontend builds may override the RPM limit or feature gate with the
corresponding `VITE_TRANSCRIPT_POLISHING_*` variables;
the provider model remains server-controlled by `TRANSCRIPT_POLISHING_MODEL`.

## Read and UI Model

Live and history views keep the existing content types:

- `rawSource` and `rawTranslation` are the canonical audit/recovery values.
- `refinedSource` and `refinedTranslation` are optional effective values.
- A Cue's `refinement` object stores status, version, input hash, execution
  identity, timestamps, and safe failure metadata.
- `polishedArticle` is derived from effective finalized Cue values.

The same Cue row updates after a completed output is persisted. Raw content can
still be inspected and explicitly exported. Failed polishing leaves raw values
visible and does not affect Live controls or audio downloads.
The Live view also shows queued, running, completed, and failed polishing
states, with a retry action for failed executions.

## Stable subtitle resegmentation

Final Cues are held in a short stability window (currently 1.5 seconds). A new
adjacent Cue resets that window; stop, pause, segment rollover, and meeting
completion flush it immediately. The request uses `mode: "subtitle_resegment"`
and sends the bounded complete group as `items` with `cueId`, `sequence`,
`rawSource`, and `rawTranslation`.

Gemini returns ordered `refinedCues`. The application verifies complete,
duplicate-free source Cue coverage, then allocates timestamps from the original
group window. Gemini never supplies milliseconds. Completed
`refinedSubtitleCues` are persisted beside raw `finalCues` and preferred by
history/read models and SRT/VTT export; raw Cues remain available for recovery
and raw export.
