# Background Jobs and MP3

Supabase Queues are the durable source for translation and MP3 work when
`BACKGROUND_JOBS_MODE=supabase`. Queue messages contain only owner, execution,
request, artifact, and segment identifiers. A database trigger enqueues queued
translation executions and ready WebM artifacts.

Each ready WebM segment has at most one `mp3` artifact. MP3 work is independent
of WebM, subtitle, and Meeting status. Its lifecycle is `queued`, `processing`,
`ready`, or `failed`, with three attempts maximum. Failed artifacts can be
requeued through the authenticated retry endpoint.

The queue RPC boundary carries the `read_ct` claim fence and supports lease
renewal, acknowledgement, retry, and archive operations. Production consumers
must claim only after the HTTP request has returned and must scope every lookup
by `owner_user_id`.
