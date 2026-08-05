# AI Meeting Summary Persistence (WP2)

`createMeetingSummaryPersistenceService` persists each generation attempt as a
`MeetingSummary` associated with a `sessionId`. A pending attempt becomes
`completed` only after the summary pipeline returns structured data. Provider
failures transition the attempt to `failed` and are rethrown; retry creates a
new attempt, preserving the failed record.

The repository permits at most one non-failed summary per Session. Completed
records reject all updates, and summaries can be listed or retrieved by
Session ID. The memory and file-backed adapters share the same domain rules.
