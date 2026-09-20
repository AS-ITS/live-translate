import { test, expect } from '@playwright/test';

function stagingSession() {
  const token = requiredEnv('CLOUD_TEST_ACCESS_TOKEN');
  const supabaseUrl = requiredEnv('CLOUD_SUPABASE_URL').replace(/\/+$/u, '');
  const parsedUrl = new URL(supabaseUrl);
  const claims = decodeJwtPayload(token);
  const expectedIssuer = `${supabaseUrl}/auth/v1`;

  if (claims.iss !== expectedIssuer) {
    throw new Error('CLOUD_TEST_ACCESS_TOKEN issuer does not match CLOUD_SUPABASE_URL.');
  }
  if (typeof claims.sub !== 'string' || !claims.sub.trim()) {
    throw new Error('CLOUD_TEST_ACCESS_TOKEN is missing sub.');
  }
  if (typeof claims.email !== 'string' || !claims.email.trim()) {
    throw new Error('CLOUD_TEST_ACCESS_TOKEN is missing email.');
  }
  if (!Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('CLOUD_TEST_ACCESS_TOKEN is expired or has no valid exp.');
  }

  const projectRef = projectRefFor(parsedUrl);
  const expiresIn = Math.max(1, claims.exp - Math.floor(Date.now() / 1000));
  return {
    storageKey: `sb-${projectRef}-auth-token`,
    session: {
      access_token: token,
      refresh_token: 'issue35-browser-reload-placeholder',
      token_type: 'bearer',
      expires_in: expiresIn,
      expires_at: claims.exp,
      user: { id: claims.sub, email: claims.email, role: 'authenticated' }
    }
  };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Issue #35 browser E2E.`);
  return value;
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('CLOUD_TEST_ACCESS_TOKEN is not a JWT.');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('CLOUD_TEST_ACCESS_TOKEN payload is invalid.');
  }
}

function projectRefFor(url) {
  const hostname = url.hostname.toLowerCase();
  if (!hostname.endsWith('.supabase.co')) {
    throw new Error('CLOUD_SUPABASE_URL must use a Supabase project hostname.');
  }
  const projectRef = hostname.slice(0, -'.supabase.co'.length);
  if (!/^[a-z0-9-]+$/u.test(projectRef)) {
    throw new Error('CLOUD_SUPABASE_URL has an invalid project ref.');
  }
  return projectRef;
}

async function installStagingSession(context, auth) {
  await context.addInitScript(({ storageKey, session }) => {
    for (const key of Object.keys(localStorage)) {
      if (/^sb-.*-auth-token$/u.test(key)) localStorage.removeItem(key);
    }
    localStorage.setItem(storageKey, JSON.stringify(session));
  }, auth);
}

function uniqueMeetingName() {
  return `codex-issue35-browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test('Meeting settings survives a fresh authenticated browser context and reload', async ({ browser, request }) => {
  const auth = stagingSession();
  const baseURL = requiredEnv('CLOUD_BASE_URL');
  let contextA = await browser.newContext({ baseURL });
  let meetingId = null;

  try {
    await installStagingSession(contextA, auth);
    const pageA = await contextA.newPage();
    await pageA.goto('/#meeting-settings?mode=create');
    await expect(pageA.getByRole('heading', { name: '基本資訊' })).toBeVisible();

    const initialName = uniqueMeetingName();
    await pageA.getByLabel('會議名稱').fill(initialName);
    const createResponsePromise = pageA.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/api/meetings')
    ));
    await pageA.getByRole('button', { name: '建立會議' }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);
    meetingId = (await createResponse.json()).meeting?.id;
    expect(meetingId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    await expect(pageA.getByRole('heading', { name: '分享會議' })).toBeVisible();
    await contextA.close();
    contextA = null;

    const contextB = await browser.newContext({ baseURL });
    try {
      await installStagingSession(contextB, auth);
      const pageB = await contextB.newPage();
      await pageB.goto(`/#meeting-settings?mode=edit&meetingId=${encodeURIComponent(meetingId)}`);
      await expect(pageB.getByRole('heading', { name: '基本資訊' })).toBeVisible();
      await expect(pageB.getByLabel('會議名稱')).toHaveValue(initialName);

      const updatedName = `${initialName} updated`;
      await pageB.getByLabel('會議名稱').fill(updatedName);
      const updateResponsePromise = pageB.waitForResponse((response) => (
        response.request().method() === 'PATCH' && response.url().includes(`/api/meetings/${meetingId}`)
      ));
      await pageB.getByRole('button', { name: '儲存會議設定' }).click();
      expect((await updateResponsePromise).status()).toBe(200);
      await pageB.reload();
      await expect(pageB.getByLabel('會議名稱')).toHaveValue(updatedName);
    } finally {
      await contextB.close();
    }
  } finally {
    if (meetingId) {
      const deleted = await request.delete(`/api/meetings/${encodeURIComponent(meetingId)}`);
      expect(deleted.status()).toBe(204);
    }
    await contextA?.close();
  }
});
