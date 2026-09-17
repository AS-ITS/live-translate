# Account Permissions

## Google Workspace account provisioning

Domain-matching Google Workspace users are provisioned as `pending` members on first sign-in. A super_admin must approve the profile before application access is granted; approval changes the status to `active`.

Users do not create passwords in Live Translate. A user whose Google account matches `AUTH_ALLOWED_EMAIL_DOMAINS` can sign in through the existing Google OAuth flow; Supabase creates `auth.users` and the existing profile trigger provisions a `pending` `member` profile on first sign-in. The account management page lists users after their first login and does not create Auth credentials. `super_admin` promotion remains outside this UI and uses the controlled bootstrap/promotion flow.

## Super-admin account list API

The account API accepts `pending` as a status filter. `POST /api/admin/users/:id/approve` is restricted to active super_admin actors and performs only `pending -> active`.

`GET /api/admin/users?page=1&pageSize=12&query=&status=all` returns only the requested page. `pageSize` accepts `12`, `24`, or `48`; `status` accepts `all`, `active`, `pending`, or `disabled`; `query` searches email and stored role text and is limited to 100 characters. The response includes `pagination` with exact totals, `counts` for all statuses, and `transferTargets` containing every active account's `id` and `email`, so asset transfer remains possible across pages.

Issue #33 establishes two authenticated account roles: `member` and `super_admin`.

New profiles default to `member` and `pending`; existing `active` and `disabled` profiles remain unchanged. The server loads role/status from the owner-scoped `profiles` record after JWT validation. Disabled accounts receive `auth_forbidden` and cannot use private APIs.

`super_admin` bootstrap is controlled by `public.bootstrap_super_admin(uuid, text)`. The function is service-role-only and requires the issued Supabase user UUID to match the email.

Meeting membership is represented by `meeting_members`, keyed by `(owner_user_id, meeting_id, user_id)`. Owners manage membership. Active members may record an assigned meeting, update its checkpoint, publish finalized cues, and upload that meeting's source audio. Meeting settings, shares, glossary, export, and deletion remain owner-only.

Meeting Settings exposes a `成員與錄製權限` step after a meeting is created. A meeting owner can invite an active `member`; invited members default to `canRecord: true`, and the owner can revoke or restore that recording permission without changing the membership. A member can always record a meeting they own. An active `super_admin` retains all member capabilities and can record any meeting, including meetings owned by another account, without acquiring or changing the meeting owner. `super_admin` can also manage membership for any meeting.

Super admins can list accounts and enable or disable accounts. Disabling requires an active transfer target and atomically transfers meetings, transcript assets, glossary entries, exports, and related records while preserving viewer share IDs. Gemini credentials are never transferred. Server-only audit records exclude secrets, tokens, audio, and transcript text.

Viewer shares remain anonymous, opaque, read-only capabilities. They do not grant access to profiles, Gemini credentials, or authenticated owner APIs.

Meeting owners can update `PATCH /api/meetings/:meetingId/members/:userId` with `{ "canRecord": false }`. New members default to `canRecord: true`; recording requires an active account, membership, and enabled recording permission.

Active super admins can query `GET /api/admin/audit-logs` with `page`, `pageSize` (`25`, `50`, `100`), `action`, `result`, and `query`. Results expose only actor, target, meeting, request, action, result, and timestamp fields.

## Issue #33 approval clarification

Domain matching is the first gate, not immediate application access. New profiles are `member` with `pending` status until an active `super_admin` approves them. Pending users may only read `GET /api/profile`, wait for approval, sign out, or switch accounts; they cannot use Meeting, Gemini, or admin APIs. There is no password flow, recorder role, or independent allowlist table. Existing `active` and `disabled` profiles remain unchanged by the migration.
