# AI Meeting Summary API (WP3)

`GET /api/sessions/:sessionId/summary` reads through the Session Summary query
service and controller. It returns the persisted summary record for completed,
pending, or failed generation attempts. A missing record returns a deterministic
`404` with `meeting_summary_not_found`.

The route does not regenerate, mutate, or reconstruct summary data.
