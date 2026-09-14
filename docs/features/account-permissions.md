# Account Permissions

Issue #33 establishes two authenticated account roles: `member` and `super_admin`.

New profiles default to `member` and `active`. The server loads role/status from the owner-scoped `profiles` record after JWT validation. Disabled accounts receive `auth_forbidden` and cannot use private APIs.

`super_admin` bootstrap is controlled by `public.bootstrap_super_admin(uuid, text)`. The function is service-role-only and requires the issued Supabase user UUID to match the email.

Meeting membership is represented by `meeting_members`, keyed by `(owner_user_id, meeting_id, user_id)`. Owners manage membership. Active members may record an assigned meeting, update its checkpoint, publish finalized cues, and upload that meeting's source audio. Meeting settings, shares, glossary, export, and deletion remain owner-only.

Super admins can list accounts and enable or disable accounts. Disabling requires an active transfer target and atomically transfers meetings, transcript assets, glossary entries, exports, and related records while preserving viewer share IDs. Gemini credentials are never transferred. Server-only audit records exclude secrets, tokens, audio, and transcript text.

Viewer shares remain anonymous, opaque, read-only capabilities. They do not grant access to profiles, Gemini credentials, or authenticated owner APIs.
