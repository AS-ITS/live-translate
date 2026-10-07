import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../../supabase/migrations/20260930000000_issue37_remove_gemini_credential_store.sql', import.meta.url);

test('credential removal migration deletes only row-linked Vault secrets before dropping legacy API and table', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const cleanupIndex = sql.indexOf('perform vault.delete_secret(credential_secret_id);');
  const revokeIndex = sql.indexOf('revoke all on function public.get_my_gemini_credential(uuid)');
  const dropTableIndex = sql.indexOf('drop table public.gemini_credentials;');

  assert.ok(cleanupIndex >= 0);
  assert.ok(revokeIndex > cleanupIndex);
  assert.ok(dropTableIndex > revokeIndex);
  assert.match(sql, /select distinct vault_secret_id\s+from public\.gemini_credentials\s+where vault_secret_id is not null/is);
  assert.doesNotMatch(sql, /delete\s+from\s+vault\.secrets/is);
  assert.doesNotMatch(sql, /insert\s+into\s+(?!public\.gemini_credentials)/is);

  for (const signature of [
    'get_my_gemini_credential\\(uuid\\)',
    'upsert_my_gemini_credential\\(uuid, text\\)',
    'delete_my_gemini_credential\\(uuid\\)',
    'read_my_gemini_key\\(uuid\\)'
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${signature}`, 'u'));
    assert.match(sql, new RegExp(`drop function public\\.${signature}`, 'u'));
  }
});
