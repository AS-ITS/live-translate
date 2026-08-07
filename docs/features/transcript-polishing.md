# Transcript Polishing

## Purpose

Transcript polishing improves finalized translation sentences while Gemini Live
Translate continues to produce the raw transcript and low-latency translation.
The polished result replaces the corresponding translation Cue; it is not a
separate article field or display.

## Runtime Contract

Only paired, final Cue records are eligible. Partial or source-only Cues stay
in the Live transcript and are not sent to the polishing provider.

The browser uses a 30-second or 200-character threshold, whichever is reached
first. Stop and Meeting Segment rollover flush pending stable Cues. A Session
has one polishing request in flight; new Cues mark the request dirty and are
submitted after the current execution finishes.

Requests use the existing TranslationRequest/TranslationExecution queue with
`operation: "transcript_polishing"`. The immutable input snapshot contains the
Cue range, bilingual text, and deterministic input hash. The provider receives
the whole batch as context and returns one polished sentence per `cueId` and
`sequence`. The resulting TranslationOutput stores the per-Cue replacements,
model, version, range, hash, and timestamps. Repeated requests with the same
polishing identity are idempotent. When several batches exist, completed
outputs are merged by `cueId`; the newest version wins for the same Cue while
older batches remain applied to their own Cues.

Provider failures, timeouts, rate limits, and retries are isolated from the
Gemini Live session. Queue retry, backoff, durable recovery, and failure
metadata use the existing translation execution infrastructure.

## Configuration

```env
TRANSCRIPT_POLISHING_ENABLED=true
TRANSCRIPT_POLISHING_MODEL=gemini-3.5-flash-lite
TRANSCRIPT_POLISHING_INTERVAL_MS=30000
TRANSCRIPT_POLISHING_MIN_CHARS=200
TRANSCRIPT_POLISHING_MAX_RPM=15
TRANSCRIPT_POLISHING_TIMEOUT_MS=30000
```

The provider receives text only. Its prompt requires preservation of meaning,
numbers, dates, names, terminology, and glossary rules, and returns one plain
text refined result for the batch. The result is stored through the existing
`translatedText` output field; no new formal translation schema field is added.
A provider failure leaves the original translation unchanged and remains
retryable through the existing execution flow.

Polishing requests do not send structured-output configuration. Provider
failures retain safe diagnostics including HTTP status, provider code/status,
provider message, model, and config field names. Prompts and transcript content
are never included in those diagnostics.

Frontend builds may override the interval, character threshold, RPM limit, or
feature gate with the corresponding `VITE_TRANSCRIPT_POLISHING_*` variables;
the provider model remains server-controlled by `TRANSCRIPT_POLISHING_MODEL`.

## Read and UI Model

Live and history views keep the existing content types:

- Raw transcript
- Live translation
- Translation with completed Cue-level polishing applied

The translation Cue, history view, and exports update only after a completed
output is persisted. Failed polishing leaves the original Live translation
unchanged and does not affect Live controls, audio downloads, or source text.
The Live view also shows queued, running, completed, and failed polishing
states, with a retry action for failed executions.
