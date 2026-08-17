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
through the existing execution flow. Queue admission respects the configured
RPM limit and uses existing timeout, retry, backoff, recovery, and DLQ paths.

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
