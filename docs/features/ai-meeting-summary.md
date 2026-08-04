# AI Meeting Summary (WP1)

The summary pipeline runs after a completed Session has persisted its Final
Subtitle Cues. Session finalization enqueues one durable `MeetingSummaryJob`
using the Session ID as its idempotency key. The enqueue is fire-and-forget
from the Session API path; a background worker claims and processes the job.

The pipeline reads cues through `listFinalCuesByMeeting`, orders them by
Meeting Segment sequence and cue timeline, and greedily splits them using the
configured maximum cue count and character budget. Chunks are summarized
sequentially through the `summaryProvider` port. The Gemini adapter uses
`gemini-3.5-flash-lite` and requests JSON with the fields `title`, `overview`,
`keyPoints`, `decisions`, and `actionItems`.

Chunk results are merged locally in chunk order. The merge keeps the first
title, joins overviews, and de-duplicates list items while preserving first
appearance order, producing a deterministic result for persistence and API
reads.

## WP5 Background Worker

`MeetingSummaryJob` is a separate domain from translation executions. Jobs are
persisted with `queued`, `processing`, `completed`, or `failed` state, lease and
fence metadata, attempt count, and retry timing. Only one queued, processing, or
completed job is retained for a Session. Retryable provider failures use capped
exponential backoff; validation and other non-retryable errors, or exhausted
attempts, persist a failed terminal job.

Startup recovery requeues queued jobs and reclaims processing jobs whose leases
expired. Completed jobs are never replayed. If a worker stops after the summary
record is persisted but before the job is terminalized, replay calls the
existing `generateAndPersist` service, which returns the completed summary
without invoking the provider again.
