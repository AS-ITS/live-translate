import { expect, test } from '@playwright/test';

test('isolated WebM spike records reproducible decode and continuity evidence', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Phase A has no verified Safari/WebKit MediaRecorder evidence.');
  test.setTimeout(30_000);
  await page.goto('/spikes/webm-continuity/');
  await expect(page.getByRole('heading', { name: /isolated WebM continuity spike/i })).toBeVisible();
  await page.getByRole('button', { name: /Run quick/ }).click();
  await page.waitForFunction(() => Boolean(globalThis.__webmSpikeResult), null, { timeout: 25_000 });

  const result = await page.evaluate(() => globalThis.__webmSpikeResult);
  expect(result.schemaVersion).toBe('webm-continuity-spike/v1');
  expect(result.method.candidateBoundaryGateMs).toBe(20);
  expect(result.method.markerWindowMs).toBe(10);
  expect(result.scenarios.continuous.recorderInstances).toBe(1);
  expect(result.scenarios.continuous.recorderRestartsAtProviderRollover).toBe(0);
  expect(result.scenarios.continuous.containerDecode[0].ok).toBe(true);
  expect(result.scenarios.rotated.containerDecode).toHaveLength(2);
  expect(result.scenarios.rotated.containerDecode.every((entry) => entry.ok)).toBe(true);
  expect(['PASS', 'FAIL', 'MEASUREMENT_UNCERTAIN']).toContain(result.comparison.candidateStatus);
  expect(result.scenarios.continuous.pauseContinue.exercised).toBe(true);
  expect(result.scenarios.rotated.pauseContinue.exercised).toBe(true);
});
