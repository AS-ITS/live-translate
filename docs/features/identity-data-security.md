# P2 Identity, Data Model, and RLS

Supabase Google OAuth uses PKCE. The browser sends its access token as `Authorization: Bearer ...`; the server validates JWT signature, issuer, audience, expiry, role, and the configured email-domain allowlist.

In cloud mode, Meeting, MeetingSegment, Session, and finalized Cue repositories are owner-scoped. Every service-role query includes `owner_user_id`, and parent-child references use the composite ownership constraints in the Supabase schema.

Users manage their Gemini API Key through `/api/profile/gemini-credential`. The key is stored as a per-user Supabase Vault secret. The application stores only the Vault reference, last four characters, and key version in `gemini_credentials`; the full value is decrypted only in server memory while creating an ephemeral token. The key is never returned to the browser or written to logs.

Existing opaque Viewer share routes remain an explicit read-only capability. They do not grant access to authenticated owner APIs or credential data.
