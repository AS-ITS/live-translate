import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test.beforeEach(async ({ page }) => {
  await installE2EAuth(page, { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' });
});

test('account management shows users and reloads after disable', async ({ page }) => {
  let disabled = false;
  let auditFailure = false;
  let auditCalls = 0;
  const auditRequests = [];
  await page.route(/\/api\/profile(?:\?.*)?$/, async (route) => route.fulfill({ json: { profile: { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' } } }));
  await page.route(/\/api\/admin\/audit-logs(?:\?.*)?$/, async (route) => {
    auditCalls += 1;
    if (auditFailure) return route.fulfill({ status: 503, json: { error: { code: 'cloud_capability_unavailable' }, requestId: 'audit-e2e-1' } });
    const url = new URL(route.request().url());
    auditRequests.push({ page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize') });
    return route.fulfill({ json: { logs: [{ actor_user_id: 'admin-1', target_user_id: 'source-1', target_meeting_id: 'meeting-1', request_id: 'request-1', action: url.searchParams.get('action') === 'all' ? 'user_disabled' : url.searchParams.get('action'), result: url.searchParams.get('result') === 'all' ? 'success' : url.searchParams.get('result'), created_at: '2026-09-15T00:00:00Z' }], pagination: { page: Number(url.searchParams.get('page') || 1), pageSize: 25, total: 26, totalPages: 2 } } });
  });
  await page.route(/\/api\/admin\/users(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { users: [{ id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' }, { id: 'source-1', email: 'source@example.com', role: 'member', status: disabled ? 'disabled' : 'active' }, { id: 'target-1', email: 'target@example.com', role: 'member', status: 'active' }], transferTargets: [{ id: 'admin-1', email: 'admin@example.com' }, { id: 'source-1', email: 'source@example.com' }, { id: 'target-1', email: 'target@example.com' }], counts: { all: 3, active: disabled ? 2 : 3, disabled: disabled ? 1 : 0 }, pagination: { page: 1, pageSize: 12, total: 3, totalPages: 1 } } });
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/#admin');
  await expect(page.locator('.account-summary-card strong').first()).toHaveText('3');
  await expect(page.locator('.account-management-data-grid .ag-row').filter({ hasText: 'admin@example.com' }).getByText('目前帳號')).toBeVisible();
  const searchInput = page.getByRole('textbox', { name: '搜尋帳號' });
  await searchInput.fill('source@example.com');
  await expect(page.locator('.account-management-data-grid .ag-cell[col-id="email"]', { hasText: 'source@example.com' })).toHaveCount(1);
  await searchInput.fill('');
  const sourceRow = page.locator('.account-management-data-grid .ag-row').filter({ has: page.locator('.ag-cell[col-id="email"]', { hasText: /^source@example\.com$/ }) }).first();
  await sourceRow.getByRole('combobox', { name: '資產接手者：source@example.com' }).selectOption('target-1');
  const currentSourceRow = page.locator('.account-management-data-grid .ag-row').filter({ has: page.locator('.ag-cell[col-id="email"]', { hasText: /^source@example\.com$/ }) }).first();
  await expect(currentSourceRow.getByRole('button', { name: '停用帳號' })).toBeEnabled();
  let disableRequestBody;
  await page.route(/\/api\/admin\/users\/source-1\/disable(?:\?.*)?$/, async (route) => {
    disableRequestBody = route.request().postDataJSON();
    disabled = true;
    await route.fulfill({ json: { user: { id: 'source-1', status: 'disabled' } } });
  });
  const [disableResponse, usersReload] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/admin/users/source-1/disable'),
    page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/admin/users'),
    currentSourceRow.getByRole('button', { name: '停用帳號' }).evaluate((button) => button.click()),
  ]);
  expect(disableResponse.status()).toBe(200);
  expect(disableRequestBody).toEqual({ transferToUserId: 'target-1' });
  expect(usersReload.status()).toBe(200);
  await expect(page.getByText('帳號狀態已更新。')).toBeVisible();
  await expect(page.getByRole('button', { name: '重新啟用帳號' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '稽核紀錄' })).toHaveCount(0);

  await page.goto('/#audit');
  await expect(page.locator('#audit-log-page-title')).toBeVisible();
  await expect(page.getByRole('link', { name: '返回會議管理' })).toHaveAttribute('href', '#meetings');
  await expect(page.locator('.audit-log-page .account-management-panel-header')).toHaveCount(0);
  await expect(page.locator('.account-audit-data-grid')).toBeVisible();
  await expect(page.locator('.account-audit-data-grid .ag-header-cell')).toHaveCount(7);
  await expect(page.getByRole('gridcell', { name: '停用帳號' })).toBeVisible();
  await page.getByRole('combobox', { name: '篩選稽核動作' }).selectOption('member_invited');
  await expect(page.getByRole('gridcell', { name: '邀請成員' })).toBeVisible();
  await page.getByRole('combobox', { name: '篩選稽核動作' }).selectOption('auth_login');
  await expect(page.getByRole('gridcell', { name: '登入' })).toBeVisible();
  await page.getByRole('combobox', { name: '篩選稽核結果' }).selectOption('failure');
  await expect(page.getByRole('gridcell', { name: '失敗' })).toBeVisible();
  await page.getByRole('button', { name: '下一頁' }).click();
  await expect(page.getByText('第 2 / 2 頁')).toBeVisible();
  await expect.poll(() => auditRequests.at(-1)?.page).toBe('2');
  await page.getByRole('combobox', { name: '稽核紀錄每頁筆數' }).selectOption('50');
  await expect(page.getByText('第 1 / 2 頁')).toBeVisible();
  await expect.poll(() => auditRequests.at(-1)?.pageSize).toBe('50');
  auditFailure = true;
  await page.getByRole('combobox', { name: '篩選稽核結果' }).selectOption('success');
  await expect(page.getByRole('button', { name: '重新載入稽核紀錄' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('cloud_capability_unavailable');
  expect(auditCalls).toBeGreaterThan(1);
  auditFailure = false;
  await page.getByRole('button', { name: '重新載入稽核紀錄' }).evaluate((button) => button.click());
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('keeps an unauthorized personal account on an access-denied screen until account switch', async ({ page }) => {
  let oauthUrl = null;
  await page.route(/\/api\/profile(?:\?.*)?$/, async (route) => route.fulfill({ status: 403, json: { error: { code: 'auth_forbidden' }, requestId: 'request-personal-1' } }));
  await page.route('**/auth/v1/authorize**', async (route) => { oauthUrl = route.request().url(); await route.fulfill({ status: 200, body: 'OAuth mock' }); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '此帳號無法使用此 Workspace' })).toBeVisible();
  await page.getByRole('button', { name: '切換 Google 帳號' }).click();
  await expect.poll(() => oauthUrl).toContain('prompt=select_account');
});

test('keeps a domain-matching pending account on the approval waiting screen', async ({ page }) => {
  await page.route(/\/api\/profile(?:\?.*)?$/, async (route) => route.fulfill({ json: { profile: { id: 'pending-1', email: 'pending@example.com', role: 'member', status: 'pending' } } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '等待管理員核准' })).toBeVisible();
  await expect(page.getByText('pending@example.com')).toBeVisible();
});
