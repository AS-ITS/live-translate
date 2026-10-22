import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { installE2EAuth } from './authBootstrap.js';

const meetingDetail = (id) => ({
  meeting: { id, name: `Meeting ${id}`, status: 'completed', sourceLanguageCode: 'en', targetLanguageCode: 'fr' },
  cues: id === 'B' ? [
    {
      cueId: 'cue-B', sessionId: 'session-B', segmentId: null, sequence: 1,
      revision: 1, status: 'final', startTimeMs: 0, endTimeMs: 1000,
      sourceText: 'Source B', translatedText: 'Translation B'
    },
    {
      cueId: 'cue-B-other', sessionId: 'session-B', segmentId: null, sequence: 2,
      revision: 1, status: 'final', startTimeMs: 1000, endTimeMs: 2000,
      sourceText: 'Source B', translatedText: 'Translation B'
    }
  ] : [],
  transcriptItems: [], audioArtifacts: []
});

async function saveUnassigned(page, meetingId, status = 'final') {
  await page.evaluate(async ({ meetingId, status }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    await createIndexedDbLocalMeetingManifestStore().saveUnassignedCue({
      meetingId, sessionId: `session-${meetingId}`, cueId: `cue-${meetingId}`,
      sequence: 1, revision: 1, reason: 'missing_original_segment',
      cue: {
        cueId: `cue-${meetingId}`, sessionId: `session-${meetingId}`, segmentId: null,
        sequence: 1, status, startTimeMs: 0, endTimeMs: 1000,
        sourceText: `Source ${meetingId}`, translatedText: `Translation ${meetingId}`
      }
    });
  }, { meetingId, status });
}

async function openExport(page, meetingId) {
  await page.evaluate((id) => { window.location.hash = `#meeting-detail?meetingId=${id}`; }, meetingId);
  await expect(page.getByRole('heading', { name: `Meeting ${meetingId}` })).toBeVisible();
  await page.getByRole('navigation', { name: '會議內容目錄' }).getByRole('button', { name: '匯出' }).click();
}

async function exportedText(page) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '開始匯出' }).click();
  const download = await downloadPromise;
  return readFile(await download.path(), 'utf8');
}

test('IndexedDB unassigned final Cues survive an A/B switch and reject failed reads', async ({ page }) => {
  await installE2EAuth(page);
  let conflictingB = false;
  await page.route(/\/api\/meetings\/(A|B|C)$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const detail = meetingDetail(id);
    if (id === 'B' && conflictingB) detail.cues[0].translatedText = 'Conflicting B';
    await route.fulfill({ json: detail });
  });

  await page.goto('/');
  await saveUnassigned(page, 'A');
  await saveUnassigned(page, 'B');
  await page.evaluate(async () => {
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    await createIndexedDbLocalMeetingManifestStore().saveUnassignedCue({
      meetingId: 'B', sessionId: 'session-B', cueId: 'cue-B-local-only',
      sequence: 3, revision: 1, reason: 'missing_original_segment',
      cue: {
        cueId: 'cue-B-local-only', sessionId: 'session-B', segmentId: null,
        sequence: 3, status: 'final', startTimeMs: 2000, endTimeMs: 3000,
        sourceText: 'Local source B', translatedText: 'Local translation B'
      }
    });
    await createIndexedDbLocalMeetingManifestStore().saveUnassignedCue({
      meetingId: 'B', sessionId: 'session-B', cueId: 'cue-B-partial',
      sequence: 4, revision: 1, reason: 'missing_original_segment',
      cue: {
        cueId: 'cue-B-partial', sessionId: 'session-B', segmentId: null,
        sequence: 4, status: 'partial', startTimeMs: 3000, endTimeMs: 4000,
        sourceText: 'Partial B', translatedText: 'Partial B'
      }
    });
  await createIndexedDbLocalMeetingManifestStore().saveUnassignedCue({
    meetingId: 'B', sessionId: 'session-B', cueId: 'cue-B-dismissed',
    sequence: 5, revision: 1, reason: 'missing_original_segment',
    cue: {
      cueId: 'cue-B-dismissed', sessionId: 'session-B', segmentId: null,
      sequence: 5, status: 'final', dismissed: true,
      startTimeMs: 4000, endTimeMs: 5000,
      sourceText: 'Dismissed B', translatedText: 'Dismissed B'
    }
  });
  });
  await page.evaluate(() => {
    const original = IDBIndex.prototype.getAll;
    window.__aReadStarted = new Promise((resolve) => { window.__markAReadStarted = resolve; });
    window.__aReadDone = new Promise((resolve) => { window.__markAReadDone = resolve; });
    window.__aReadGate = new Promise((resolve) => { window.__releaseARead = resolve; });
    IDBIndex.prototype.getAll = function (...args) {
      const request = original.apply(this, args);
      if (this.objectStore.name !== 'unassignedCues' || args[0] !== 'A') return request;
      return {
        get result() { return request.result; },
        get error() { return request.error; },
        set onsuccess(callback) {
          request.addEventListener('success', () => {
            window.__markAReadStarted();
            void window.__aReadGate.then(() => {
              callback();
              window.__markAReadDone();
            });
          });
        },
        set onerror(callback) { request.addEventListener('error', callback); }
      };
    };
    window.__restoreDelayedRead = () => { IDBIndex.prototype.getAll = original; };
  });
  await page.evaluate(() => { window.location.hash = '#meeting-detail?meetingId=A'; });
  await page.evaluate(() => window.__aReadStarted);
  await openExport(page, 'B');
  await expect(page.getByRole('button', { name: '開始匯出' })).toBeEnabled();
  await page.evaluate(() => {
    window.__releaseARead();
    window.__restoreDelayedRead();
  });
  await page.evaluate(() => window.__aReadDone);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByRole('button', { name: '開始匯出' })).toBeEnabled();
  const bText = await exportedText(page);
  expect(bText.match(/Translation B/g)).toHaveLength(2);
  expect(bText).toContain('Local translation B');
  expect(bText).not.toContain('Translation A');
  expect(bText).not.toContain('Partial B');
  expect(bText).not.toContain('Dismissed B');

  await openExport(page, 'C');
  await expect(page.getByRole('region', { name: '雲端字幕匯出' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  conflictingB = true;
  await openExport(page, 'A');
  await page.evaluate(() => { window.location.hash = '#meeting-detail?meetingId=B'; });
  await expect(page.getByRole('alert')).toContainText('字幕資料衝突');
  await expect(page.getByRole('button', { name: '開始匯出' })).toHaveCount(0);
  conflictingB = false;
  await page.getByRole('button', { name: '重試' }).click();
  await expect(page.getByRole('heading', { name: 'Meeting B' })).toBeVisible();

  await page.evaluate(() => {
    const original = IDBIndex.prototype.getAll;
    IDBIndex.prototype.getAll = function (...args) {
      if (this.objectStore.name === 'unassignedCues') throw new Error('fixture read failure');
      return original.apply(this, args);
    };
    window.__restoreUnassignedGetAll = () => { IDBIndex.prototype.getAll = original; };
  });
  await page.evaluate(() => { window.location.hash = '#meeting-detail?meetingId=A'; });
  await expect(page.getByRole('alert')).toContainText('本機字幕資料載入失敗');
  await page.evaluate(() => { window.location.hash = '#meeting-detail?meetingId=B'; });
  await expect(page.getByRole('alert')).toContainText('本機字幕資料載入失敗');
  await expect(page.getByRole('button', { name: '開始匯出' })).toHaveCount(0);
  await page.evaluate(() => window.__restoreUnassignedGetAll());
  await page.getByRole('button', { name: '重試' }).click();
  await page.getByRole('navigation', { name: '會議內容目錄' }).getByRole('button', { name: '匯出' }).click();
  await expect(page.getByRole('button', { name: '開始匯出' })).toBeEnabled();
  expect(await exportedText(page)).toContain('Translation B');
});
