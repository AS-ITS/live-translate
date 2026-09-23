import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationPath = new URL('../../supabase/migrations/20260924000000_issue37_meeting_lifecycle_v2.sql', import.meta.url);
const fenceMigrationPath = new URL('../../supabase/migrations/20260924010000_issue37_validate_recorder_fence.sql', import.meta.url);

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
