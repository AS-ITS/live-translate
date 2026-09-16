import { expect, test } from '@playwright/test';

function installSession(page) {
  return page.addInitScript(() => {
    localStorage.setItem('sb-hvvyzeqhdijfqtasgdvg-auth-token', JSON.stringify({ access_token: 'e2e-access-token', refresh_token: 'e2e-refresh-token', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'admin-1', email: 'admin@example.com', role: 'authenticated' } }));
  });
}

test('account management shows users, audit logs, filters, pagination, and reloads after disable', async ({ page }) => {
  let disabled = false;
  let auditFailure = false;
  let auditCalls = 0;
  await page.route(/\/api\/profile(?:\?.*)?$/, async (route) => route.fulfill({ json: { profile: { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' } } }));
  await page.route(/\/api\/admin\/audit-logs(?:\?.*)?$/, async (route) => {
    auditCalls += 1;
    if (auditFailure) return route.fulfill({ status: 503, json: { error: { code: 'cloud_capability_unavailable' }, requestId: 'audit-e2e-1' } });
    const url = new URL(route.request().url());
    return route.fulfill({ json: { logs: [{ actor_user_id: 'admin-1', target_user_id: 'source-1', target_meeting_id: 'meeting-1', request_id: 'request-1', action: url.searchParams.get('action') === 'all' ? 'user_disabled' : url.searchParams.get('action'), result: url.searchParams.get('result') === 'all' ? 'success' : url.searchParams.get('result'), created_at: '2026-09-15T00:00:00Z' }], pagination: { page: Number(url.searchParams.get('page') || 1), pageSize: 25, total: 26, totalPages: 2 } } });
  });
  await page.route(/\/api\/admin\/users(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { users: [{ id: 'source-1', email: 'source@example.com', role: 'member', status: disabled ? 'disabled' : 'active' }, { id: 'target-1', email: 'target@example.com', role: 'member', status: 'active' }], transferTargets: [{ id: 'source-1', email: 'source@example.com' }, { id: 'target-1', email: 'target@example.com' }], counts: { all: 2, active: disabled ? 1 : 2, disabled: disabled ? 1 : 0 }, pagination: { page: 1, pageSize: 12, total: 2, totalPages: 1 } } });
  });
  await page.route(/\/api\/admin\/users\/source-1\/disable(?:\?.*)?$/, async (route) => { disabled = true; await route.fulfill({ json: { user: { id: 'source-1', status: 'disabled' } } }); });
  await installSession(page);
  await page.goto('/#admin');
  await expect(page.locator('.account-summary-card strong').first()).toHaveText('2');
  const searchInput = page.getByRole('textbox', { name: '搜尋帳號' });
  await searchInput.fill('source@example.com');
  await expect(page.locator('.account-management-data-grid .ag-cell[col-id="email"]', { hasText: 'source@example.com' })).toHaveCount(1);
  await searchInput.fill('');
  const sourceRow = page.locator('.account-management-data-grid .ag-row').filter({ has: page.locator('.ag-cell[col-id="email"]', { hasText: /^source@example\.com$/ }) }).first();
  await sourceRow.getByRole('combobox', { name: '資產接手者：source@example.com' }).selectOption('target-1');
  const currentSourceRow = page.locator('.account-management-data-grid .ag-row').filter({ has: page.locator('.ag-cell[col-id="email"]', { hasText: /^source@example\.com$/ }) }).first();
  await expect(currentSourceRow.getByRole('button', { name: '停用帳號' })).toBeEnabled();
  await page.evaluate(() => { window.confirm = () => true; });
  const disableResponse = page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/admin\/users\/source-1\/disable(?:\?.*)?$/.test(new URL(response.url()).pathname + new URL(response.url()).search));
  const usersReload = page.waitForResponse((response) => response.request().method() === 'GET' && /\/api\/admin\/users(?:\?.*)?$/.test(new URL(response.url()).pathname + new URL(response.url()).search));
  await currentSourceRow.getByRole('button', { name: '停用帳號' }).click({ force: true });
  await expect((await disableResponse).status()).toBe(200);
  await expect((await usersReload).status()).toBe(200);
  await expect(page.getByText('帳號狀態已更新。')).toBeVisible();
  const disabledRow = page.locator('.account-management-data-grid .ag-row', { hasText: 'source@example.com' }).first();
  await expect(disabledRow.getByRole('button', { name: '重新啟用帳號' })).toBeVisible();
  await expect(page.getByText('user_disabled')).toBeVisible();
  await page.getByRole('combobox', { name: '篩選稽核動作' }).selectOption('member_invited');
  await expect(page.getByText('member_invited')).toBeVisible();
  await page.getByRole('combobox', { name: '篩選稽核結果' }).selectOption('failure');
  await expect(page.getByText('failure')).toBeVisible();
  await page.getByRole('button', { name: '下一頁' }).last().click();
  await expect(page.getByText('第 2 / 2 頁')).toBeVisible();
  auditFailure = true;
  await page.getByRole('button', { name: '重新載入稽核紀錄' }).click();
  await expect(page.getByRole('alert')).toContainText('cloud_capability_unavailable');
  expect(auditCalls).toBeGreaterThan(1);
  auditFailure = false;
  await page.getByRole('button', { name: '重新載入稽核紀錄' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('keeps an unauthorized personal account on an access-denied screen until account switch', async ({ page }) => {
  let oauthUrl = null;
  await page.route(/\/api\/profile(?:\?.*)?$/, async (route) => route.fulfill({ status: 403, json: { error: { code: 'auth_forbidden' }, requestId: 'request-personal-1' } }));
  await page.route('**/auth/v1/authorize**', async (route) => { oauthUrl = route.request().url(); await route.fulfill({ status: 200, body: 'OAuth mock' }); });
  await page.addInitScript(() => localStorage.setItem('sb-hvvyzeqhdijfqtasgdvg-auth-token', JSON.stringify({ access_token: 'personal-access-token', refresh_token: 'personal-refresh-token', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'personal-1', email: 'personal@gmail.com', role: 'authenticated' } })));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '此帳號無法使用此 Workspace' })).toBeVisible();
  await page.getByRole('button', { name: '切換 Google 帳號' }).click();
  await expect.poll(() => oauthUrl).toContain('prompt=select_account');
});
