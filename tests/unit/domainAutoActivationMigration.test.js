import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../../supabase/migrations/20261002000000_domain_auto_activation.sql', import.meta.url);

test('domain auto-activation migration keeps new profiles pending until backend validation', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /insert into public\.profiles \(id, email, full_name, avatar_url, role, status\)/u);
  assert.match(sql, /'member',\s*'pending'/u);
  assert.match(sql, /on conflict \(id\) do update[\s\S]*updated_at = now\(\)/u);
  assert.doesNotMatch(sql, /on conflict \(id\) do update[\s\S]*status = excluded\.status/u);
});

test('activation RPC is service-role-only and conditionally changes pending status', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const functionSql = sql.slice(sql.indexOf('create or replace function public.activate_pending_profile'));
  assert.match(functionSql, /set status = 'active'[\s\S]*where id = target_user_id\s*and status = 'pending'/u);
  assert.doesNotMatch(functionSql, /set[\s\S]*role\s*=/u);
  assert.match(functionSql, /select \* into result[\s\S]*where id = target_user_id/u);
  assert.match(sql, /revoke all on function public\.activate_pending_profile\(uuid\) from public, anon, authenticated/u);
  assert.match(sql, /grant execute on function public\.activate_pending_profile\(uuid\) to service_role/u);
});
