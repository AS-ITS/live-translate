# Account Permissions

Issue #33 establishes two authenticated account roles: `member` and `super_admin`.

New profiles default to `member` and `active`. The server loads role and status from the owner-scoped `profiles` record after JWT validation. Disabled accounts receive the existing `auth_forbidden` response and cannot use private APIs.

`super_admin` bootstrap is controlled by `public.bootstrap_super_admin(uuid, text)`. Deployment must provide the issued Supabase user UUID and matching email. The function is service-role-only and fails when the UUID/email pair does not match.

Meeting membership is represented by `meeting_members`, keyed by `(owner_user_id, meeting_id, user_id)`. The owner manages membership. An invited member receives only the meeting capability granted by the relevant application policy and never gains owner, credential, or cross-account access.

Viewer shares remain anonymous, opaque, read-only capabilities. They do not grant access to profiles, Gemini credentials, or authenticated owner APIs.
