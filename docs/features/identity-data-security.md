# P1 Identity, Data Model, and RLS

P1 uses Supabase Google OAuth with PKCE. The browser persists and refreshes the
Supabase session, then sends its access token as `Authorization: Bearer ...`.
The server validates JWT signature, issuer, audience, expiry, role, and the
comma-separated `AUTH_ALLOWED_EMAIL_DOMAINS` allowlist. Profile rows are
created or updated by an `auth.users` trigger and are returned only by
`GET /api/profile` for the authenticated user.

The migration creates owner-scoped domain tables with non-null
`owner_user_id`, composite parent-child foreign keys, idempotency/version
constraints, hash-only viewer shares, and encrypted-value-only Gemini
credential placeholders. All tables have RLS. Client grants are revoked and
re-added only for the authenticated Profile read path; `service_role` is
server-only. P1 leaves all non-Profile adapters disabled and fail-closed with
`cloud_capability_unavailable`.
