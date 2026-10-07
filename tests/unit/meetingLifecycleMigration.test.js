import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationPath = new URL('../../supabase/migrations/20260924000000_issue37_meeting_lifecycle_v2.sql', import.meta.url);
const fenceMigrationPath = new URL('../../supabase/migrations/20260924010000_issue37_validate_recorder_fence.sql', import.meta.url);
const hardeningMigrationPath = new URL('../../supabase/migrations/20260924020000_issue37_phase1_hardening.sql', import.meta.url);
const createMeetingCompatibilityMigrationPath = new URL('../../supabase/migrations/20260924030000_fix_meeting_creation_retention_defaults.sql', import.meta.url);

test('Issue #37 migration defines v2 invariants and transactional RPCs', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  for (const expected of [
    'lifecycle_contract_version',
    'lifecycle_version',
    'sessions_one_open_v2_per_meeting_idx',
    'meeting_segments_one_active_v2_per_meeting_idx',
    'meeting_lifecycle_operations',
    'execute_meeting_lifecycle_command',
    'renew_meeting_recorder_lease',
    'touch_meeting_liveness',
    "interval '10 seconds'",
    "interval '30 seconds'"
  ]) assert.ok(sql.includes(expected), `migration missing ${expected}`);
});

test('Meeting creation RPC fills defaults for retention columns added after the original RPC', async () => {
  const sql = await readFile(createMeetingCompatibilityMigrationPath, 'utf8');

  assert.match(sql, /create or replace function public\.create_meeting_with_initial_segment/u);
  assert.match(sql, /jsonb_populate_record\(null::public\.meetings, normalized_meeting\)/u);
  assert.match(sql, /retention_policy_version.*coalesce/u);
  assert.match(sql, /purge_status[\s\S]*not_scheduled/u);
  assert.match(sql, /purge_attempt_count.*coalesce/u);
});

test('Issue #37 write fence rejects stale cue, checkpoint, and audio writers', async () => {
  const sql = await readFile(fenceMigrationPath, 'utf8');
  assert.match(sql, /validate_meeting_recorder_write/u);
  assert.match(sql, /rl\.fence_token = p_fence_token/u);
  assert.match(sql, /rl\.expires_at > clock_timestamp\(\)/u);
  assert.match(sql, /raise exception 'recorder_lease_invalid'/u);
  assert.match(sql, /grant execute[\s\S]+to service_role;/u);
});

test('Issue #37 migration keeps lifecycle RPCs service-role only', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  assert.match(sql, /revoke all on function public\.execute_meeting_lifecycle_command[\s\S]+from public, anon, authenticated;/u);
  assert.match(sql, /grant execute on function public\.execute_meeting_lifecycle_command[\s\S]+to service_role;/u);
});

test('Issue #37 hardening migration protects stale v2 meetings and retention claims', async () => {
  const sql = await readFile(hardeningMigrationPath, 'utf8');

  for (const expected of [
    'retention_policy_version',
    'purge_status',
    'purge_claimed_at',
    'purge_claimed_by',
    'purge_attempt_count',
    'meetings_purge_due_idx',
    'meeting_segments_v2_session_required_check',
    'enforce_v2_current_segment_active',
    'reject_terminal_v2_meeting_write',
    'reject_expired_v2_audio_artifact_write',
    'expire_stale_meetings',
    'claim_due_meeting_purges'
  ]) {
    assert.ok(sql.includes(expected), `hardening migration must include ${expected}`);
  }

  assert.match(sql, /for update skip locked/u);
  assert.match(sql, /last_heartbeat_at <= now_at - interval '15 minutes'/u);
  assert.match(sql, /purge_at = coalesce\(purge_at, now_at \+ interval '30 minutes'\)/u);
  assert.match(sql, /status = 'interrupted'/u);
  assert.match(sql, /set revoked_at = coalesce\(revoked_at, now_at\)/u);
  assert.match(sql, /set expires_at = now_at/u);
  assert.match(sql, /raise exception 'meeting_terminal'/u);
  assert.match(sql, /clock_timestamp\(\) >= target_purge_at/u);
  assert.match(sql, /raise exception 'meeting_purge_deadline_expired'/u);
  assert.match(sql, /before insert or update on public\.audio_artifacts/u);
  assert.match(sql, /deferrable initially deferred/u);
  assert.match(sql, /revoke all on function public\.expire_stale_meetings\(integer\) from public, anon, authenticated;/u);
  assert.match(sql, /grant execute on function public\.claim_due_meeting_purges\(text, integer\) to service_role;/u);
});

test('Issue #37 Cue relationship accepts lifecycle v1 and keeps Viewer segment join', async () => {
  const migration = new URL(
    '../../supabase/migrations/20261001000000_fix_legacy_cue_segment_fk.sql',
    import.meta.url
  );
  const sql = await readFile(migration, 'utf8');

  assert.match(sql, /subtitle_cues_session_segment_relationship_fkey/u);
  assert.match(
    sql,
    /foreign key \(owner_user_id, segment_id\)[\s\S]*references public\.meeting_segments\(owner_user_id, id\)/u
  );
  assert.doesNotMatch(sql, /foreign key \(owner_user_id, session_id, segment_id\)/u);
});
