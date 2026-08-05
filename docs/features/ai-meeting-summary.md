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

The source builder filters empty and punctuation-only entries, de-duplicates
Cue identities, rejects conflicting duplicates, and hashes a canonical source
representation. New records retain `sourceType`, `sourceHash`, source Cue and
character counts, and source schema version. Sessions without persisted Final
Cues use finalized legacy source transcript only when no Cue source exists;
Cue integrity errors never silently fall back.

Failed summaries can be manually retried with
`POST /api/sessions/:sessionId/summary/retry`. The retry creates a new durable
job and summary attempt while retaining the failed attempt and preserving the
same source hash.

## WP5 Background Worker

`MeetingSummaryJob` is a separate domain from translation executions. Jobs are
persisted with `queued`, `processing`, `completed`, or `failed` state, lease and
fence metadata, attempt count, and retry timing. Only one queued, processing, or
completed final job is retained for a Session; incremental partial jobs use
range identity. Retryable provider failures use capped
exponential backoff; validation and other non-retryable errors, or exhausted
attempts, persist a failed terminal job.

Startup recovery requeues queued jobs and reclaims processing jobs whose leases
expired. Completed jobs are never replayed. If a worker stops after the summary
record is persisted but before the job is terminalized, replay calls the
existing `generateAndPersist` service, which returns the completed summary
without invoking the provider again.

## WP6 Incremental Meeting Summary

`MeetingSummary` records have a `kind` of `partial` or `final`. Partial records
carry a stable range identity containing the Segment ID/sequence and first and
last Final Subtitle Cue IDs. Multiple partial records are allowed for one
Session only when their range identities differ. Final records retain the
WP1–WP5 invariant of at most one active final summary per Session.

When a Meeting Segment is finalized, the persisted Final Subtitle Cues for that
Segment are grouped into one range and a partial job is enqueued with the stable
key `partial:<sessionId>:<rangeKey>`. The existing summary provider and worker
lease, fence, retry, and restart-recovery behavior process the range. Failed
partial attempts remain as history and can be retried without replacing a
completed partial record.

Session finalization enqueues the separate stable final-merge key
`final:<sessionId>`. The merge reads only completed partial summaries, validates
that the required persisted Cue ranges exist exactly once, sorts by Segment
sequence and Cue range, and merges them chronologically. Missing or failed
partial ranges leave the final job retryable. The existing summary API returns
the final record only.

## WP7 Meeting Summary Export

Completed final summaries can be exported from Session Detail as PDF, Markdown,
DOCX, or TXT. Export content is derived from the same structured summary data
rendered by the Meeting Summary section: Executive Summary, Key Topics,
Decisions, and Action Items. Partial, pending, failed, and missing summaries do
not expose export actions.

Exports are generated in the browser and use the deterministic filename pattern
`live-translate-summary-<sessionId>-<exportTimestamp>.<format>`. This path is
separate from translation and subtitle export behavior.

## WP8 Rich Meeting Summary

Final summaries derive optional structured insights from persisted Final
Subtitle Cues and completed partial summaries. The final record carries
timeline, keywords, risks, openQuestions, and followUpSuggestions alongside
the existing summary fields. Timeline entries remain chronological, and older
persisted records remain readable when these fields are absent.
