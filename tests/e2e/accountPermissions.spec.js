import { expect, test } from '@playwright/test';

test('account management shows active transfer targets and reloads after disable', async ({ page }) => {
  let disabled = false;
  await page.route('**/api/profile', async (route) => route.fulfill({ json: {
    profile: { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' }
  } }));
  await page.route('**/api/admin/users', async (route) => route.fulfill({ json: { users: [
    { id: 'source-1', email: 'source@example.com', role: 'member', status: disabled ? 'disabled' : 'active' },
    { id: 'target-1', email: 'target@example.com', role: 'member', status: 'active' }
  ] } }));
  await page.route('**/api/admin/users/source-1/disable', async (route) => {
    disabled = true;
    await route.fulfill({ json: { user: { id: 'source-1', status: 'disabled' } } });
  });
  await page.addInitScript(() => {
    const session = {
      access_token: 'e2e-access-token',
      refresh_token: 'e2e-refresh-token',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'admin-1', email: 'admin@example.com', role: 'authenticated' }
    };
    localStorage.setItem('sb-hvvyzeqhdijfqtasgdvg-auth-token', JSON.stringify(session));
  });
  await page.goto('/#admin');
  await expect(page.getByRole('heading', { name: '帳號管理' })).toBeVisible();
  const sourceRow = page.locator('article').first();
  await sourceRow.getByLabel('資產接手者').selectOption('target-1');
  await sourceRow.getByRole('button', { name: '停用' }).click();
  await expect(page.getByText('帳號狀態已更新。')).toBeVisible();
  await expect(sourceRow.getByRole('button', { name: '啟用' })).toBeVisible();
});
test('keeps an unauthorized personal account on an access-denied screen until account switch', async ({ page }) => {
  let profileRequests = 0;
  let oauthUrl = null;
  await page.route('**/api/profile', async (route) => {
    profileRequests += 1;
    await route.fulfill({ status: 403, json: { error: { code: 'auth_forbidden' }, requestId: 'request-personal-1' } });
  });
  await page.route('**/auth/v1/authorize**', async (route) => {
    oauthUrl = route.request().url();
    await route.fulfill({ status: 200, body: 'OAuth mock' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('sb-hvvyzeqhdijfqtasgdvg-auth-token', JSON.stringify({
      access_token: 'personal-access-token', refresh_token: 'personal-refresh-token', token_type: 'bearer',
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'personal-1', email: 'personal@gmail.com', role: 'authenticated' }
    }));
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '此帳號無法使用此 Workspace' })).toBeVisible();
  await expect(page.getByTestId('auth-account-email')).toHaveText('personal@gmail.com');
  await expect(page.getByText('安全工作區')).toHaveCount(1);
  await expect(page.getByText('Workspace 管理')).toHaveCount(0);
  expect(profileRequests).toBe(1);

  await page.getByRole('button', { name: '切換 Google 帳號' }).click();
  await expect.poll(() => oauthUrl).toContain('prompt=select_account');
  expect(profileRequests).toBe(1);
});
