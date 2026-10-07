# Account Permissions

## Google Workspace account provisioning

Users sign in with Google OAuth through Supabase; Live Translate has no password flow. The backend validates the Supabase JWT signature, issuer, audience, expiry, authenticated role, and `AUTH_ALLOWED_EMAIL_DOMAINS`. Domain comparison is case-normalized and exact. An empty allowlist, a subdomain, or a suffix lookalike is rejected.

The Supabase Auth trigger creates a `member` profile with transient `pending` status. On the first authenticated backend request, the trusted service-role-only `activate_pending_profile` RPC conditionally changes only `pending -> active`. The same flow activates existing pending profiles after their next valid sign-in. The RPC never changes `role`; a `super_admin` remains a `super_admin`.

The conditional update and the administrator disable RPC serialize on the profile row. A profile already changed to `disabled` is returned as disabled and is rejected with `auth_forbidden`; automatic activation cannot change `disabled -> active`. Missing profiles, failed reads, and failed activation return explicit `503` errors and never fall back to a synthetic active profile.

The Auth trigger and profile default remain `pending` so an Auth user is never activated before backend JWT/domain validation. Authenticated users have only owner-scoped `SELECT` access to their profile through RLS and cannot update `role` or `status` themselves.

## Super-admin account management

Active system administrators can change another profile between `member` and `super_admin` through `PATCH /api/admin/users/:userId/role`. The API keeps JWT/profile authorization and calls the service-role-only `public.update_account_role` RPC. That RPC acquires a transaction-scoped advisory lock before re-reading actor and target profiles, requires the actor to still be an active `super_admin`, rejects self-demotion and last-admin demotion, updates only `role`/`updated_at`, and inserts the successful role-change audit row in the same transaction. Same-role requests return `changed=false` without updating the profile or inserting an audit row.

Role changes do not alter `status`, `disabled_at`, Meeting ownership, Meeting membership, or Viewer permissions. `AUTH_ALLOWED_EMAIL_DOMAINS` continues to control only trusted `pending -> active` activation and never grants `super_admin`.

`GET /api/admin/users?page=1&pageSize=12&query=&status=all` returns the requested page. `pageSize` accepts `12`, `24`, or `48`; `status` accepts `all`, `active`, or `disabled`. The account page has no approval action. It retains enable, disable, asset transfer, search, pagination, and current-account display. A transient pending row can appear in an unfiltered list and is labeled as waiting for first login.

`super_admin` bootstrap remains the controlled, service-role-only `public.bootstrap_super_admin(uuid, text)` flow. Disabling an account requires an active transfer target and atomically transfers owner-scoped assets while preserving viewer share IDs. Gemini credentials are not transferred.

Historical `user_approved` audit rows remain readable. New login outcomes use `auth_login`; successful domain activation records a successful application login, while disabled accounts remain failures. Audit records exclude secrets, tokens, audio, and transcript text.

## Meeting and viewer permissions

An active member can create and manage owned Meetings. Recording another user's Meeting still requires existing membership and `can_record`; matching the same email domain grants no Meeting data or management access. Active super-admin Meeting behavior is unchanged.

Viewer shares remain anonymous, opaque, read-only capabilities. They do not grant access to profiles, Gemini credentials, or authenticated owner APIs. Gemini key handling is unchanged.

## Migration deployment order

Apply all existing migrations first, including `20260916010000_pending_account_approval.sql`, then apply `20261002000000_domain_auto_activation.sql`, and deploy the backend/frontend code that calls `activate_pending_profile`. Deploying the migration before the application is safe: profiles remain pending until the updated trusted backend validates and activates them. Do not batch-update existing pending profiles.
