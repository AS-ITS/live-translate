# Transcript Polishing

## Purpose

Transcript polishing creates a readable article version while Gemini Live
Translate continues to produce the raw transcript and low-latency translation.
Polished content is derived data and never replaces either Live stream.

## Runtime Contract

Only paired, final Cue records are eligible. Partial or source-only Cues stay
in the Live transcript and are not sent to the polishing provider.

The browser uses a 30-second or 200-character threshold, whichever is reached
first. Stop and Meeting Segment rollover flush pending stable Cues. A Session
has one polishing request in flight; new Cues mark the request dirty and are
submitted after the current execution finishes.

Requests use the existing TranslationRequest/TranslationExecution queue with
`operation: "transcript_polishing"`. The immutable input snapshot contains the
Cue range, bilingual text, and deterministic input hash. The resulting
TranslationOutput stores the polished text, model, version, range, hash, and
timestamps. Repeated requests with the same polishing identity are idempotent.

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
numbers, dates, names, terminology, and glossary rules, and requires a
structured `polishedText` response.

Frontend builds may override the interval, character threshold, RPM limit, or
feature gate with the corresponding `VITE_TRANSCRIPT_POLISHING_*` variables;
the provider model remains server-controlled by `TRANSCRIPT_POLISHING_MODEL`.

## Read and UI Model

Live and history views keep three separate content types:

- Raw transcript
- Live translation
- Polished article translation

The article view updates only after a completed output is persisted. Failed
polishing displays a retryable failure state without changing Live controls,
audio downloads, or transcript history.
