# AI Meeting Summary (WP1)

The summary pipeline runs after a completed session has persisted its Final
Subtitle Cues. A caller invokes `onFinalCuesFinalized({ meetingId })` on the
summary trigger after the persistence/finalization transaction succeeds.

The pipeline reads cues through `listFinalCuesByMeeting`, orders them by
Meeting Segment sequence and cue timeline, and greedily splits them using the
configured maximum cue count and character budget. Chunks are summarized
sequentially through the `summaryProvider` port. The Gemini adapter uses
`gemini-3.5-flash-lite` and requests JSON with the fields `title`, `overview`,
`keyPoints`, `decisions`, and `actionItems`.

Chunk results are merged locally in chunk order. The merge keeps the first
title, joins overviews, and de-duplicates list items while preserving first
appearance order, producing a deterministic result suitable for a future
persistence or API layer.
