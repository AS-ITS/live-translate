import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../../supabase/migrations/20261007000000_account_role_management.sql', import.meta.url);

test('account role migration preserves audit actions and makes role changes atomic', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const action of ['member_invited', 'member_removed', 'member_recording_permission_changed', 'user_approved', 'user_enabled', 'user_disabled', 'asset_transfer', 'auth_login', 'account.role.promoted', 'account.role.demoted']) {
    assert.match(sql, new RegExp(`'${action.replaceAll('.', '\\.')}'`, 'u'));
  }
  assert.match(sql, /add column if not exists target_email text/u);
  assert.match(sql, /add column if not exists old_role text/u);
  assert.match(sql, /add column if not exists new_role text/u);

  const body = sql.slice(sql.indexOf('create or replace function public.update_account_role'));
  const lock = body.indexOf("pg_advisory_xact_lock(hashtext('public.update_account_role'))");
  const actorRead = body.indexOf('into actor_profile');
  const targetRead = body.indexOf('into target_profile');
  const update = body.indexOf('update public.profiles');
  const audit = body.indexOf('insert into public.audit_logs');
  assert.ok(lock >= 0 && lock < actorRead && actorRead < targetRead && targetRead < update && update < audit);
  assert.match(body, /actor_profile\.status <> 'active'/u);
  assert.match(body, /actor_profile\.role <> 'super_admin'/u);
  assert.match(body, /if target_profile\.role = p_new_role then[\s\S]*'ok', false/u);
  assert.match(body, /if remaining_admins <= 1 then[\s\S]*'last_super_admin'/u);
  assert.match(body, /set role = p_new_role,[\s\S]*updated_at = now\(\)/u);
  assert.doesNotMatch(body.slice(update, audit), /status\s*=/u);
  assert.match(body, /revoke all on function public\.update_account_role[\s\S]*from public, anon, authenticated/u);
  assert.match(body, /grant execute on function public\.update_account_role[\s\S]*to service_role/u);
});
