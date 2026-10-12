# P2 Identity, Data Model, and RLS

Supabase Google OAuth uses PKCE. The browser sends its access token as
`Authorization: Bearer ...`; the server validates JWT signature, issuer,
audience, expiry, role, and the configured email-domain allowlist. Cloud
repositories are owner-scoped and service-role queries include
`owner_user_id`.

Viewer share routes are read-only and do not grant access to authenticated
owner APIs or credential data.

## GSK-04 Gemini credential boundary

`POST /api/live-token` uses only the authenticated recorder's explicit,
request-scoped `geminiApiKey`. It does not depend on stored credentials or a
`GEMINI_API_KEY` fallback. The request key is used only to create the
short-lived Live token and then cleared. Viewer requests do not request or
receive a Gemini key or token.

The former profile credential API, `geminiCredentialApiClient`, and
`gemini_credentials` store are removed from the current implementation. They
must not be reintroduced as a Live token input or replacement persistent store.

The decommission sequence is: (1) stop all readers and writers of the profile
credential API and `gemini_credentials`; (2) deploy the request-scoped Live
token path and verify recorder and Viewer authorization; (3) add and apply a
forward migration that drops the credential RPCs and table and deletes
row-linked Vault secrets; and (4) run an explicit, audited cleanup of any
remaining legacy credential rows and provider secrets. Existing user keys are
not migrated to another persistent location. Rollback is limited to reverting
the application deployment before destructive cleanup; after removal, recovery
requires the user to provide a new request key.

Other non-Live backend Gemini workflows may use an isolated environment key
through their own provider composition. That key is not shared with recorder
requests and is never a Live token fallback. Live token responses use
`Cache-Control: no-store`; logs, audit records, metrics, and telemetry must not
contain API keys, ephemeral tokens, stored credentials, request keys, or
secret-bearing payloads.
