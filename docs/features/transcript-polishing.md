# Transcript Polishing

## Purpose

Transcript polishing improves finalized bilingual Cues while Gemini Live
Translate continues to produce the immutable raw transcript and low-latency
translation. The polished result is stored as an independent article output;
it never replaces Cue, transcript, or session-record text.

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
the whole batch as context and returns one polished source and translation
sentence per `cueId` and `sequence`. The resulting TranslationOutput stores the per-Cue replacements,
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

The provider receives finalized source/translation context but returns only
`polishedText` for the translation article. Its prompt requires preservation of
meaning, numbers, dates, names, terminology, and glossary rules. A provider
failure leaves the raw transcript, Live translation, and Cues unchanged and
remains retryable through the existing execution flow.

The response is addressable by `cueId` and `sequence`; legacy outputs that only
contain translation text remain readable and do not change source text.
Provider failures retain safe diagnostics including HTTP status, provider
code/status, provider message, model, and config field names. Prompts and
transcript content are never included in those diagnostics.

Frontend builds may override the interval, character threshold, RPM limit, or
feature gate with the corresponding `VITE_TRANSCRIPT_POLISHING_*` variables;
the provider model remains server-controlled by `TRANSCRIPT_POLISHING_MODEL`.

## Read and UI Model

Live and history views keep the existing content types:

- Raw source recognition is retained as the canonical audit/recovery source.
- Live source and translation text always remain the original Gemini Live result.
- Completed polishing outputs are exposed separately as `polishedArticle`.

Only the independent article view updates after a completed output is
persisted. Cues, transcript items, and Live exports remain unchanged. Failed
polishing leaves the original Live source and translation unchanged and does
not affect Live controls or audio downloads.
The Live view also shows queued, running, completed, and failed polishing
states, with a retry action for failed executions.
