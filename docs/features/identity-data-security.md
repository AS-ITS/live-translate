# P2 Identity, Data Model, and RLS

Supabase Google OAuth uses PKCE. The browser sends its access token as `Authorization: Bearer ...`; the server validates JWT signature, issuer, audience, expiry, role, and the configured email-domain allowlist.

In cloud mode, Meeting, MeetingSegment, Session, and finalized Cue repositories are owner-scoped. Every service-role query includes `owner_user_id`, and parent-child references use the composite ownership constraints in the Supabase schema.

The legacy profile credential API, `geminiCredentialApiClient`, and `gemini_credentials` remain a compatibility layer for a later controlled migration/removal. They are not inputs to the Live token flow, and historical credential data is not claimed to be deleted.

Existing opaque Viewer share routes remain an explicit read-only capability. They do not grant access to authenticated owner APIs or credential data.
## GSK-04 Gemini credential boundary

The Live token flow is request-scoped. `POST /api/live-token` uses only the explicit request `geminiApiKey`; it no longer depends on `/api/profile/gemini-credential`, stored credentials, `gemini_credentials`, or a `GEMINI_API_KEY` fallback. The request key is used only to create the short-lived Live token, then is cleared from request handling state.

The legacy profile credential API, `geminiCredentialApiClient`, the `gemini_credentials` store, and historical credential data remain a compatibility layer for a later controlled migration/removal. They must not be reused by Live or by the new request-key path. This boundary does not claim that historical data has been deleted.

Other non-Live backend Gemini workflows may continue to use an isolated environment key through their own provider composition. That environment key is not shared with the recorder request key or used as a Live token fallback.

Live token success and error responses use `Cache-Control: no-store`. Logs, audit records, metrics, and telemetry must not contain API keys, ephemeral tokens, stored credentials, request keys, or secret-bearing payloads.
