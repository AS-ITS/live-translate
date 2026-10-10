import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = new URL('../../supabase/migrations/20261010000000_transactional_legacy_resume.sql', import.meta.url);
const bindingFixMigration = new URL(
  '../../supabase/migrations/20261010010000_fix_legacy_resume_session_binding.sql',
  import.meta.url
);

test('legacy resume RPC is transactional, durable, service-role only, and payload fenced', async () => {
  const sql = await readFile(migration, 'utf8');
  assert.match(sql, /create or replace function public\.resume_legacy_meeting_segment/u);
  assert.match(sql, /for update/u);
  assert.match(sql, /meeting_lifecycle_operations/u);
  assert.match(sql, /prior_operation\.request_payload <> request_value/u);
  assert.match(sql, /raise exception 'meeting_lifecycle_conflict'/u);
  assert.match(sql, /source_segment\.session_id is distinct from p_expected_session_id/u);
  assert.match(sql, /checkpoint_conflict/u);
  assert.match(sql, /'globalGlossaryEntries', coalesce\(p_global_glossary_entries/u);
  assert.match(sql, /revoke all on function public\.resume_legacy_meeting_segment[\s\S]*from public, anon, authenticated/u);
  assert.match(sql, /grant execute on function public\.resume_legacy_meeting_segment[\s\S]*to service_role/u);
});

test('legacy resume nullable session binding stays v1-only and fail-closed', async () => {
  const sql = await readFile(bindingFixMigration, 'utf8');

  assert.match(sql, /create or replace function public\.resume_legacy_meeting_segment/u);
  assert.match(sql, /security definer[\s\S]*set search_path = public/u);
  assert.match(sql, /source_segment\.session_id is not null/u);
  assert.match(sql, /p_expected_session_id is null/u);
  assert.match(sql, /source_segment\.session_id is distinct from p_expected_session_id/u);
  assert.match(sql, /from public\.sessions[\s\S]*for share/u);
  assert.match(sql, /bound_session\.meeting_id is distinct from p_meeting_id/u);
  assert.match(sql, /bound_session\.segment_id is distinct from p_source_segment_id/u);
  assert.match(sql, /bound_session\.lifecycle_contract_version <> 1/u);
  assert.match(sql, /bound_session\.status not in \('created', 'active', 'paused'\)/u);
  assert.match(sql, /session_id = effective_session_id/u);
  assert.match(sql, /p_meeting_id, effective_session_id, 1/u);
  assert.match(sql, /revoke all on function public\.resume_legacy_meeting_segment[\s\S]*from public, anon, authenticated/u);
  assert.match(sql, /grant execute on function public\.resume_legacy_meeting_segment[\s\S]*to service_role/u);
});

test('idempotency payload excludes mutable global glossary snapshot', async () => {
  const sql = await readFile(migration, 'utf8');
  const requestBlock = sql.slice(sql.indexOf('request_value :='), sql.indexOf('select * into prior_operation'));
  assert.doesNotMatch(requestBlock, /globalGlossaryEntries/u);
});
