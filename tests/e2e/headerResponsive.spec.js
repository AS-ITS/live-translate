import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

const VIEWPORT_WIDTHS = [375, 390, 430, 768, 1024, 1280, 1440];
const HEADER_DESKTOP_MIN_WIDTH = 1200;
const FEATURE_PAGES = [
  { link: 'Gemini Key', hash: '#settings' },
  { link: '帳號管理', hash: '#admin' },
  { link: '稽核紀錄', hash: '#audit' }
];

async function openMeetingManagement(page, profile) {
  await installE2EAuth(page, profile);
  await page.goto('/#meetings');
  await expect(page.getByRole('heading', { name: '會議管理', exact: true })).toBeVisible();
}

async function expectHeaderLayout(page, width) {
  await page.setViewportSize({ width, height: 900 });
  const menuButton = page.getByRole('button', { name: '開啟導覽選單' });
  const desktopActions = page.locator('.app-header-actions');

  if (width < HEADER_DESKTOP_MIN_WIDTH) {
    await expect(menuButton).toBeVisible();
    await expect(desktopActions).toBeHidden();
  } else {
    await expect(menuButton).toBeHidden();
    await expect(desktopActions).toBeVisible();
  }

  const layout = await page.evaluate(() => {
    const header = document.querySelector('.meeting-app-header');
    const bar = header?.querySelector('.app-header-bar');
    const visibleControls = [...(header?.querySelectorAll('.button, .account-menu-trigger') || [])]
      .filter((element) => element.getClientRects().length > 0);
    return {
      headerChildCount: header?.children.length,
      flexWrap: bar ? getComputedStyle(bar).flexWrap : '',
      barFits: Boolean(bar && bar.scrollWidth <= bar.clientWidth),
      controlsFit: visibleControls.every((element) => (
        getComputedStyle(element).whiteSpace === 'nowrap'
        && element.scrollWidth <= element.clientWidth
      )),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth
    };
  });

  expect(layout).toEqual({
    headerChildCount: 1,
    flexWrap: 'nowrap',
    barFits: true,
    controlsFit: true,
    noHorizontalOverflow: true
  });
}

async function expectFeatureLinks(scope, currentLink, role = 'super_admin') {
  const allowedLinks = role === 'super_admin'
    ? FEATURE_PAGES.map(({ link }) => link)
    : ['Gemini Key'];

  for (const { link } of FEATURE_PAGES) {
    const expectedCount = allowedLinks.includes(link) && link !== currentLink ? 1 : 0;
    await expect(scope.getByRole('link', { name: link, exact: true })).toHaveCount(expectedCount);
  }
}

async function expectMenuFits(page, menu) {
  const layout = await menu.evaluate((element) => {
    const controls = [...element.querySelectorAll('.mobile-nav-links .button')];
    return {
      controlsFit: controls.every((control) => (
        getComputedStyle(control).whiteSpace === 'nowrap'
        && control.scrollWidth <= control.clientWidth
      )),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth
    };
  });
  expect(layout).toEqual({ controlsFit: true, noHorizontalOverflow: true });
}

test('owner keeps role permissions and a single-row header at every required width', async ({ page }) => {
  await openMeetingManagement(page, { id: 'owner-1', email: 'owner@example.com', role: 'owner', status: 'active' });

  for (const width of VIEWPORT_WIDTHS) {
    await expectHeaderLayout(page, width);
  }

  await page.setViewportSize({ width: 390, height: 900 });
  const menuButton = page.getByRole('button', { name: '開啟導覽選單' });
  await menuButton.click();
  let menu = page.getByRole('dialog', { name: '導覽選單' });
  await expectFeatureLinks(menu, null, 'owner');
  await expectMenuFits(page, menu);

  await menu.getByRole('link', { name: 'Gemini Key' }).click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(menu).toHaveCount(0);

  await menuButton.click();
  menu = page.getByRole('dialog', { name: '導覽選單' });
  await expectFeatureLinks(menu, 'Gemini Key', 'owner');
  await menu.getByRole('link', { name: '返回會議管理' }).click();
  await expect(page).toHaveURL(/#meetings$/);
  await expect(menu).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expectFeatureLinks(page.locator('.app-header-actions'), null, 'owner');
});

test('super admin mobile menu hides only the current feature and closes after navigation', async ({ page }) => {
  await openMeetingManagement(page, { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' });

  for (const width of VIEWPORT_WIDTHS) {
    await expectHeaderLayout(page, width);
  }

  await page.setViewportSize({ width: 390, height: 900 });
  const menuButton = page.getByRole('button', { name: '開啟導覽選單' });

  for (const featurePage of FEATURE_PAGES) {
    await menuButton.click();
    let menu = page.getByRole('dialog', { name: '導覽選單' });
    await expectFeatureLinks(menu, null);
    await menu.getByRole('link', { name: featurePage.link }).click();
    await expect(page).toHaveURL(new RegExp(`${featurePage.hash}$`));
    await expect(menu).toHaveCount(0);

    await menuButton.click();
    menu = page.getByRole('dialog', { name: '導覽選單' });
    await expectFeatureLinks(menu, featurePage.link);
    await expectMenuFits(page, menu);
    await expect(menu.getByRole('link', { name: '返回會議管理' })).toBeVisible();
    await menu.getByRole('link', { name: '返回會議管理' }).click();
    await expect(page).toHaveURL(/#meetings$/);
    await expect(menu).toHaveCount(0);
  }
});

test('desktop feature actions follow direct entry, reload, back, and forward navigation', async ({ page }) => {
  await openMeetingManagement(page, { id: 'admin-1', email: 'admin@example.com', role: 'super_admin', status: 'active' });
  await page.setViewportSize({ width: 1280, height: 900 });
  const actions = page.locator('.app-header-actions');

  await expectFeatureLinks(actions, null);
  await actions.getByRole('link', { name: 'Gemini Key' }).click();
  await expectFeatureLinks(actions, 'Gemini Key');
  await expect(page.getByRole('link', { name: '返回會議管理' })).toBeVisible();

  await page.reload();
  await expectFeatureLinks(actions, 'Gemini Key');
  await actions.getByRole('link', { name: '帳號管理' }).click();
  await expectFeatureLinks(actions, '帳號管理');

  await page.goBack();
  await expect(page).toHaveURL(/#settings$/);
  await expectFeatureLinks(actions, 'Gemini Key');
  await page.goForward();
  await expect(page).toHaveURL(/#admin$/);
  await expectFeatureLinks(actions, '帳號管理');

  await page.goto('/#audit');
  await expectFeatureLinks(actions, '稽核紀錄');
  await expectHeaderLayout(page, 1280);
  await page.reload();
  await expectFeatureLinks(actions, '稽核紀錄');

  await page.getByRole('link', { name: '返回會議管理' }).click();
  await expect(page).toHaveURL(/#meetings$/);
  await expectFeatureLinks(actions, null);
});
