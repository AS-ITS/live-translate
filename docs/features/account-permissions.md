# Account Permissions

## Super-admin account list API

`GET /api/admin/users?page=1&pageSize=12&query=&status=all` returns only the requested page. `pageSize` accepts `12`, `24`, or `48`; `status` accepts `all`, `active`, or `disabled`; `query` searches email and stored role text and is limited to 100 characters. The response includes `pagination` with exact totals, `counts` for all statuses, and `transferTargets` containing every active account's `id` and `email`, so asset transfer remains possible across pages.

Issue #33 establishes two authenticated account roles: `member` and `super_admin`.

New profiles default to `member` and `active`. The server loads role/status from the owner-scoped `profiles` record after JWT validation. Disabled accounts receive `auth_forbidden` and cannot use private APIs.

`super_admin` bootstrap is controlled by `public.bootstrap_super_admin(uuid, text)`. The function is service-role-only and requires the issued Supabase user UUID to match the email.

Meeting membership is represented by `meeting_members`, keyed by `(owner_user_id, meeting_id, user_id)`. Owners manage membership. Active members may record an assigned meeting, update its checkpoint, publish finalized cues, and upload that meeting's source audio. Meeting settings, shares, glossary, export, and deletion remain owner-only.

Super admins can list accounts and enable or disable accounts. Disabling requires an active transfer target and atomically transfers meetings, transcript assets, glossary entries, exports, and related records while preserving viewer share IDs. Gemini credentials are never transferred. Server-only audit records exclude secrets, tokens, audio, and transcript text.

Viewer shares remain anonymous, opaque, read-only capabilities. They do not grant access to profiles, Gemini credentials, or authenticated owner APIs.
## Recording controls and audit query

The super-admin UI presents audit records on the independent `#audit` page. The
`#admin` page is reserved for account listing and account status operations.

Meeting owners can update `PATCH /api/meetings/:meetingId/members/:userId` with `{ "canRecord": false }`. New members default to `canRecord: true`; recording requires an active account, membership, and enabled recording permission.

Active super admins can query `GET /api/admin/audit-logs` with `page`, `pageSize` (`25`, `50`, `100`), `action`, `result`, and `query`. Results expose only actor, target, meeting, request, action, result, and timestamp fields.
