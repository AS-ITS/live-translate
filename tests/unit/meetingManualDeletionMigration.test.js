import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../../supabase/migrations/20261007010000_manual_meeting_deletion_after_expiry.sql', import.meta.url);

test('expiry cleanup claim RPCs are no-ops so physical deletion remains manual', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /claim_due_recording_cleanup[\s\S]*return;/u);
  assert.match(sql, /claim_due_meeting_purges[\s\S]*return '\[\]'::jsonb;/u);
  assert.doesNotMatch(sql, /delete\s+from/u);
});
