import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const roleTest = process.env.RUN_SUPABASE_ROLE_TESTS === 'true' ? test : test.skip;

roleTest('concurrent cross-demotion keeps at least one super_admin and writes only one success audit', async (t) => {
  const baseUrl = String(process.env.SUPABASE_TEST_URL || process.env.SUPABASE_URL || '').replace(/\/$/u, '');
  const serviceKey = String(process.env.SUPABASE_TEST_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '');
  assert.ok(baseUrl && serviceKey, 'local Supabase URL and service-role key are required');
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname), 'role concurrency test must use local Supabase');

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };
  const adminA = await createUser('a');
  const adminB = await createUser('b');
  const statusTarget = await createUser('status-target');
  const requestA = `role-race-a-${randomUUID()}`;
  const requestB = `role-race-b-${randomUUID()}`;

  t.after(async () => {
    const ids = `(${adminA.id},${adminB.id},${statusTarget.id})`;
    await fetch(`${baseUrl}/rest/v1/audit_logs?actor_user_id=in.${ids}`, { method: 'DELETE', headers });
    await fetch(`${baseUrl}/rest/v1/audit_logs?target_user_id=in.${ids}`, { method: 'DELETE', headers });
    await Promise.all([adminA, adminB, statusTarget].map((user) => fetch(`${baseUrl}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', headers })));
  });

  await Promise.all([adminA, adminB].map((user) => updateProfile(user.id, { role: 'super_admin', status: 'active', disabled_at: null })));

  const beforeNoChange = await getProfile(adminA.id);
  const noChange = await rpc({
    p_actor_user_id: adminA.id,
    p_target_user_id: adminA.id,
    p_new_role: 'super_admin',
    p_request_id: `role-same-${randomUUID()}`
  });
  assert.equal(noChange[0]?.outcome, 'ok');
  assert.equal(noChange[0]?.changed, false);
  assert.equal((await getProfile(adminA.id)).updated_at, beforeNoChange.updated_at);

  for (const status of ['active', 'pending', 'disabled']) {
    await updateProfile(statusTarget.id, { role: 'member', status, disabled_at: status === 'disabled' ? new Date().toISOString() : null });
    const promoted = await rpc({
      p_actor_user_id: adminA.id,
      p_target_user_id: statusTarget.id,
      p_new_role: 'super_admin',
      p_request_id: `role-status-promote-${status}-${randomUUID()}`
    });
    assert.equal(promoted[0]?.role, 'super_admin');
    assert.equal(promoted[0]?.status, status);
    const demoted = await rpc({
      p_actor_user_id: adminA.id,
      p_target_user_id: statusTarget.id,
      p_new_role: 'member',
      p_request_id: `role-status-demote-${status}-${randomUUID()}`
    });
    assert.equal(demoted[0]?.role, 'member');
    assert.equal(demoted[0]?.status, status);
  }

  const [aDemotesB, bDemotesA] = await Promise.all([
    rpc({ p_actor_user_id: adminA.id, p_target_user_id: adminB.id, p_new_role: 'member', p_request_id: requestA }),
    rpc({ p_actor_user_id: adminB.id, p_target_user_id: adminA.id, p_new_role: 'member', p_request_id: requestB })
  ]);

  const outcomes = [aDemotesB[0], bDemotesA[0]];
  assert.equal(outcomes.filter((result) => result?.outcome === 'ok' && result.changed === true).length, 1);
  assert.equal(outcomes.filter((result) => result?.outcome === 'auth_forbidden' && result.changed === false).length, 1);

  const profiles = await rest(`profiles?id=in.(${adminA.id},${adminB.id})&select=id,role,status`);
  assert.ok(profiles.filter((profile) => profile.role === 'super_admin').length >= 1);
  assert.ok(profiles.every((profile) => profile.status === 'active'));

  const audits = await rest(`audit_logs?request_id=in.(${encodeURIComponent(requestA)},${encodeURIComponent(requestB)})&select=action,result,old_role,new_role,request_id`);
  assert.equal(audits.length, 1);
  assert.deepEqual({ action: audits[0].action, result: audits[0].result, old_role: audits[0].old_role, new_role: audits[0].new_role }, {
    action: 'account.role.demoted',
    result: 'success',
    old_role: 'super_admin',
    new_role: 'member'
  });

  async function createUser(label) {
    const response = await fetch(`${baseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: `role-race-${label}-${randomUUID()}@example.com`, password: `Role-${randomUUID()}-Aa1!`, email_confirm: true })
    });
    const text = await response.text();
    assert.ok(response.ok, `create ${label} returned HTTP ${response.status}: ${text}`);
    return JSON.parse(text);
  }

  async function updateProfile(userId, body) {
    const response = await fetch(`${baseUrl}/rest/v1/profiles?id=eq.${userId}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
    const text = await response.text();
    assert.ok(response.ok, `update profile returned HTTP ${response.status}: ${text}`);
  }

  async function getProfile(userId) {
    const rows = await rest(`profiles?id=eq.${userId}&select=id,role,status,updated_at`);
    assert.equal(rows.length, 1);
    return rows[0];
  }

  async function rpc(body) {
    const response = await fetch(`${baseUrl}/rest/v1/rpc/update_account_role`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    assert.ok(response.ok, `role RPC returned HTTP ${response.status}: ${text}`);
    return JSON.parse(text);
  }

  async function rest(path) {
    const response = await fetch(`${baseUrl}/rest/v1/${path}`, { headers });
    const text = await response.text();
    assert.ok(response.ok, `REST read returned HTTP ${response.status}: ${text}`);
    return JSON.parse(text);
  }
});
