# Schema-only Application E2E

## Strategy
- **Old Project**: hvvyzeqhdijfqtasgdvg
- **New Project**: hrosqhqlkjetebvhknwg
- **Data Migration**: CANCELLED
- **Migration Strategy**: SCHEMA_ONLY

## Current Singapore State
- 45 migrations applied
- Schema / RLS / RPC / Triggers / Realtime: Intact
- auth.users = 0
- auth.identities = 0
- Storage buckets: `meeting-audio`, `meeting-exports` (Empty)
- `public.meeting_cleanup_throttle`:
  - value: `id=true, next_run_at=-infinity`
  - classification: MIGRATION_SEED / APPLICATION_SINGLETON
  - action: RETAIN

## Environment Isolation
- **Production**: Points to Old Supabase (Unchanged)
- **Normal Preview**: Points to Old Supabase (Unchanged)
- **E2E Branch (`feat/supabase-singapore-e2e`)**: Points to New Singapore Supabase

## Bootstrap Requirements
- **System Identity**: `SUPABASE_WORKER_USER_ID` is required in ENV. It acts as a fallback owner for server-side tasks. No corresponding `auth.users` row is required as it is used as a UUID fallback.
- **Super Admin**: Required for account management. 
  - **Method**: Normal signup -> Manual upgrade via `public.bootstrap_super_admin` RPC (invoked via service_role).

## Dashboard Preconditions
- **Auth**: Site URL, Redirect URLs, SMTP, OAuth providers configured.
- **JWT**: Active signing keys, JWKS endpoint functional.
- **Realtime**: Signing public key trusted, private channel auth functional.
- **Storage**: Bucket policies configured, MIME/Size limits set.
- **Origin**: E2E branch URL added to CORS/Allowed Origins.

## Test Accounts
- **Naming**: `supabase-singapore-e2e+<timestamp>@allowed-test-domain`
- **Admin Account**: One dedicated test user promoted to `super_admin`.

## E2E Test Plan

### Auth
- [ ] Signup -> Profile trigger -> Login -> Refresh -> Logout
- [ ] Verify `auth.users` and `public.profiles` row creation and UUID match.
- [ ] Verify role defaults to `member`.

### Meeting Lifecycle
- [ ] Create meeting -> Start -> Pause -> Continue -> End
- [ ] Verify tables: `meetings`, `sessions`, `meeting_segments`, `meeting_lifecycle_operations`.
- [ ] Verify `ended_at` and `purge_at` values.

### Cue / Translation
- [ ] Source cue creation -> Translation execution -> Final cue persistence.
- [ ] Test dictionary/glossary overrides.
- [ ] Verify checkpoint persistence.

### Viewer Realtime Token
- [ ] Generate share token -> Request Realtime Token via API.
- [ ] Verify JWT: alg, kid, and expiry.
- [ ] Verify token acceptance by Singapore Supabase Realtime.

### Viewer Full Flow
- [ ] Subscribe to private channel -> Receive live subtitle event.
- [ ] Test late join and reconnection.

### Storage
- [ ] `meeting-audio`: Upload -> Read/Download -> Delete.
- [ ] `meeting-exports`: Upload -> Read/Download -> Delete.

### RLS Negative Tests
- [ ] User A cannot read User B's private meetings.
- [ ] Anonymous users cannot access owner-only data.
- [ ] Service role can perform all administrative operations.

### History / Result
- [ ] Verify history list and result lookup for new E2E meetings.
- [ ] Verify finalized cues and recording metadata.

## Test Data Cleanup
- **Delete**: All test users, profiles, meetings, sessions, cues, and storage objects created during E2E.
- **Retain**: `meeting_cleanup_throttle`, platform-managed data, and required bootstrap state.

## Production Cutover Gate
- [ ] All Dashboard config = READY.
- [ ] All E2E tests = PASS.
- [ ] Production ENV values confirmed.
- [ ] Deployment order defined.

## Rollback Plan
- **Pre-data Rollback**:
  - Rollback Vercel deployment -> Restore Old Supabase ENV -> Smoke test.
- **Post-data Incident**:
  - **DATA_VISIBILITY_RISK**: Data created in Singapore will not exist in Old Supabase.
  - **CUTOVER_OBSERVATION_WINDOW**: Define a period (e.g., 1 hour) where rollback is a simple ENV revert. After this, rollback requires data migration back to Old Supabase.
