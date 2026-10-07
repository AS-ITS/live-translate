import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

test.beforeEach(async ({ page }) => {
  await installE2EAuth(page, { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' });
});

test('system administrator promotes and demotes another account with immediate UI refresh', async ({ page }) => {
  const roles = new Map([['admin-1', 'super_admin'], ['user-1', 'member'], ['admin-2', 'super_admin']]);
  const roleRequests = [];
  const dialogs = [];

  await page.route(/\/api\/profile(?:\?.*)?$/, (route) => route.fulfill({
    json: { profile: { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' } }
  }));
  await page.route(/\/api\/admin\/users(?:\?.*)?$/, (route) => route.fulfill({
    json: {
      users: [
        { id: 'admin-1', email: 'admin@example.com', role: roles.get('admin-1'), status: 'active' },
        { id: 'user-1', email: 'user@example.com', role: roles.get('user-1'), status: 'active' },
        { id: 'admin-2', email: 'admin2@example.com', role: roles.get('admin-2'), status: 'active' }
      ],
      transferTargets: [{ id: 'admin-1', email: 'admin@example.com' }, { id: 'user-1', email: 'user@example.com' }, { id: 'admin-2', email: 'admin2@example.com' }],
      counts: { all: 3, active: 3, disabled: 0 },
      pagination: { page: 1, pageSize: 12, total: 3, totalPages: 1 }
    }
  }));
  await page.route(/\/api\/admin\/users\/user-1\/role$/, async (route) => {
    const body = route.request().postDataJSON();
    roleRequests.push(body);
    roles.set('user-1', body.role);
    await route.fulfill({ json: { changed: true, user: { id: 'user-1', email: 'user@example.com', role: body.role, status: 'active' } } });
  });
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  await page.goto('/#admin');
  const selfRow = page.getByRole('row', { name: /^admin@example\.com /u });
  await expect(selfRow.getByText('目前帳號不可操作')).toBeVisible();
  await expect(selfRow.getByRole('button')).toHaveCount(0);
  await expect(selfRow.getByRole('combobox')).toHaveCount(0);

  let userRow = page.getByRole('row', { name: /^user@example\.com /u });
  await userRow.getByRole('button', { name: '提升為系統管理者' }).click();
  await expect(page.getByText('系統角色已更新。')).toBeVisible();
  userRow = page.getByRole('row', { name: /^user@example\.com /u });
  await expect(userRow.getByText('系統管理員')).toBeVisible();
  await expect(userRow.getByRole('button', { name: '降為一般使用者' })).toBeVisible();

  await userRow.getByRole('button', { name: '降為一般使用者' }).click();
  userRow = page.getByRole('row', { name: /^user@example\.com /u });
  await expect(userRow.getByText('成員')).toBeVisible();
  expect(roleRequests).toEqual([{ role: 'super_admin' }, { role: 'member' }]);
  expect(dialogs[0]).toContain('系統管理者可以管理帳號、查看稽核紀錄及執行系統管理功能。');
  expect(dialogs[1]).toContain('降權後，此帳號將無法再使用系統管理功能。');
});

test('account management page remains vertically scrollable at narrow desktop width', async ({ page }) => {
  await page.setViewportSize({ width: 739, height: 943 });
  await page.route(/\/api\/profile(?:\?.*)?$/, (route) => route.fulfill({
    json: { profile: { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' } }
  }));
  await page.route(/\/api\/admin\/users(?:\?.*)?$/, (route) => route.fulfill({
    json: {
      users: [
        { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' },
        { id: 'user-1', email: 'user@example.com', role: 'member', status: 'active' },
        { id: 'admin-2', email: 'admin2@example.com', role: 'super_admin', status: 'active' }
      ],
      transferTargets: [{ id: 'admin-1', email: 'admin@example.com' }, { id: 'user-1', email: 'user@example.com' }, { id: 'admin-2', email: 'admin2@example.com' }],
      counts: { all: 3, active: 3, disabled: 0 },
      pagination: { page: 1, pageSize: 12, total: 3, totalPages: 1 }
    }
  }));

  await page.goto('/#admin');
  await expect(page.getByRole('heading', { name: '帳號列表' })).toBeVisible();
  const horizontalScroll = await page.evaluate(() => {
    const outer = document.querySelector('.account-management-table-scroll');
    const gridViewport = document.querySelector('.account-management-data-grid .ag-body-horizontal-scroll-viewport');
    const gridContainer = document.querySelector('.account-management-data-grid .ag-body-horizontal-scroll-container');
    return {
      outerOverflow: outer.scrollWidth - outer.clientWidth,
      gridOverflow: gridContainer.scrollWidth - gridViewport.clientWidth
    };
  });
  expect(horizontalScroll.outerOverflow).toBeLessThanOrEqual(1);
  expect(horizontalScroll.gridOverflow).toBeGreaterThan(0);

  await page.setViewportSize({ width: 916, height: 929 });
  const mediumHorizontalScroll = await page.evaluate(() => {
    const outer = document.querySelector('.account-management-table-scroll');
    const gridViewport = document.querySelector('.account-management-data-grid .ag-body-horizontal-scroll-viewport');
    const gridContainer = document.querySelector('.account-management-data-grid .ag-body-horizontal-scroll-container');
    return {
      outerOverflow: outer.scrollWidth - outer.clientWidth,
      gridOverflow: gridContainer.scrollWidth - gridViewport.clientWidth
    };
  });
  expect(mediumHorizontalScroll.outerOverflow).toBeLessThanOrEqual(1);
  expect(mediumHorizontalScroll.gridOverflow).toBeGreaterThan(0);

  const dimensions = await page.evaluate(() => ({ viewport: window.innerHeight, document: document.documentElement.scrollHeight }));
  expect(dimensions.document).toBeGreaterThan(dimensions.viewport);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(page.locator('.account-management-pagination')).toBeInViewport();
});

test('audit log page has only the AG Grid horizontal scrollbar at narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 916, height: 929 });
  await page.route(/\/api\/profile(?:\?.*)?$/, (route) => route.fulfill({
    json: { profile: { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' } }
  }));
  await page.route(/\/api\/admin\/audit-logs(?:\?.*)?$/, (route) => route.fulfill({
    json: {
      logs: Array.from({ length: 5 }, (_, index) => ({
        actor_user_id: '89a4cef2-98c1-4940-9000-000000000001',
        target_user_id: null,
        target_meeting_id: null,
        request_id: `request-${index + 1}`,
        action: 'auth_login',
        result: 'success',
        created_at: `2026-10-07T06:16:44.${700 - index}Z`
      })),
      pagination: { page: 1, pageSize: 25, total: 472, totalPages: 19 }
    }
  }));

  await page.goto('/#audit');
  await expect(page.locator('.account-audit-data-grid .ag-root')).toBeVisible();
  const horizontalScroll = await page.evaluate(() => {
    const outer = document.querySelector('.audit-log-page .account-management-table-scroll');
    const gridViewport = document.querySelector('.account-audit-data-grid .ag-body-horizontal-scroll-viewport');
    const gridContainer = document.querySelector('.account-audit-data-grid .ag-body-horizontal-scroll-container');
    return {
      outerOverflow: outer.scrollWidth - outer.clientWidth,
      gridOverflow: gridContainer.scrollWidth - gridViewport.clientWidth
    };
  });
  expect(horizontalScroll.outerOverflow).toBeLessThanOrEqual(1);
  expect(horizontalScroll.gridOverflow).toBeGreaterThan(0);

  await page.setViewportSize({ width: 660, height: 923 });
  const narrowerHorizontalScroll = await page.evaluate(() => {
    const outer = document.querySelector('.audit-log-page .account-management-table-scroll');
    const gridViewport = document.querySelector('.account-audit-data-grid .ag-body-horizontal-scroll-viewport');
    const gridContainer = document.querySelector('.account-audit-data-grid .ag-body-horizontal-scroll-container');
    return {
      outerOverflow: outer.scrollWidth - outer.clientWidth,
      gridOverflow: gridContainer.scrollWidth - gridViewport.clientWidth
    };
  });
  expect(narrowerHorizontalScroll.outerOverflow).toBeLessThanOrEqual(1);
  expect(narrowerHorizontalScroll.gridOverflow).toBeGreaterThan(0);
});

test('account API errors remain visible and do not overlap the panel in a short viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 208 });
  await page.route(/\/api\/profile(?:\?.*)?$/, (route) => route.fulfill({
    json: { profile: { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' } }
  }));
  await page.route(/\/api\/admin\/users(?:\?.*)?$/, (route) => route.fulfill({
    status: 503,
    json: { error: { code: 'cloud_capability_unavailable', message: '帳號資料暫時無法載入。', requestId: 'account-error-1' } }
  }));

  await page.goto('/#admin');
  const alert = page.getByRole('alert');
  const panel = page.locator('.account-management-panel');
  await expect(alert).toContainText('帳號資料暫時無法載入。');
  await expect(alert).toContainText('account-error-1');

  const boxes = await Promise.all([alert.boundingBox(), panel.boundingBox()]);
  expect(boxes[0].y + boxes[0].height).toBeLessThanOrEqual(boxes[1].y);
});

test('account management uses only the document for vertical scrolling at desktop width', async ({ page }) => {
  await page.setViewportSize({ width: 1860, height: 838 });
  await page.route(/\/api\/profile(?:\?.*)?$/, (route) => route.fulfill({
    json: { profile: { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' } }
  }));
  await page.route(/\/api\/admin\/users(?:\?.*)?$/, (route) => route.fulfill({
    json: {
      users: [
        { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' },
        { id: 'user-1', email: 'user@example.com', role: 'member', status: 'active' },
        { id: 'admin-2', email: 'admin2@example.com', role: 'super_admin', status: 'active' }
      ],
      transferTargets: [
        { id: 'admin-1', email: 'admin@example.com' },
        { id: 'user-1', email: 'user@example.com' },
        { id: 'admin-2', email: 'admin2@example.com' }
      ],
      counts: { all: 3, active: 3, disabled: 0 },
      pagination: { page: 1, pageSize: 12, total: 3, totalPages: 1 }
    }
  }));

  await page.goto('/#admin');
  await expect(page.getByRole('heading', { name: '帳號列表' })).toBeVisible();

  const scrolling = await page.evaluate(() => {
    const shell = document.querySelector('.account-management-shell');
    const content = document.querySelector('.account-management-page');
    return {
      shellOverflowY: getComputedStyle(shell).overflowY,
      contentOverflowY: getComputedStyle(content).overflowY,
      shellOverflow: shell.scrollHeight - shell.clientHeight,
      contentOverflow: content.scrollHeight - content.clientHeight,
      documentOverflow: document.documentElement.scrollHeight - window.innerHeight
    };
  });

  expect(scrolling.shellOverflowY).toBe('visible');
  expect(scrolling.contentOverflowY).toBe('visible');
  expect(scrolling.shellOverflow).toBeLessThanOrEqual(1);
  expect(scrolling.contentOverflow).toBeLessThanOrEqual(1);
  expect(scrolling.documentOverflow).toBeGreaterThan(0);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(page.locator('.account-management-pagination')).toBeInViewport();
});
