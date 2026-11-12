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

async function saveUnassigned(page, meetingId, status = 'final', changes = {}) {
  await page.evaluate(async ({ meetingId, status, changes }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const store = createIndexedDbLocalMeetingManifestStore();
    if (!await store.getRecording(meetingId)) {
      await store.saveRecording({ meetingId, recordingId: `session-${meetingId}`,
        ownerUserId: 'owner-1', storageIdentity: `e2e-owner-${meetingId}`,
        segmentId: `segment-${meetingId}`, segmentNumber: 1,
        captureEpoch: 1, providerEpoch: 0, state: 'paused' });
    }
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('live-translate-local-meetings-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const cueId = changes.cueId || `cue-${meetingId}`;
    const sessionId = `session-${meetingId}`;
    const sequence = changes.sequence || 1;
    const cue = { cueId, sessionId, segmentId: null, sequence, status,
      startTimeMs: changes.startTimeMs ?? 0, endTimeMs: changes.endTimeMs ?? 1000,
      sourceText: changes.sourceText || `Source ${meetingId}`,
      translatedText: changes.translatedText || `Translation ${meetingId}`,
      ...(changes.dismissed ? { dismissed: true } : {}) };
    await new Promise((resolve, reject) => {
      const tx = db.transaction('unassignedCues', 'readwrite');
      tx.objectStore('unassignedCues').put({ key: JSON.stringify([meetingId, sessionId, cueId]),
        meetingId, sessionId, cueId, segmentId: null, sequence, revision: 1,
        reason: 'missing_original_segment', cue, updatedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const stored = await store.listUnassignedCues(meetingId);
    if (!stored.some((record) => record.cueId === cueId)) throw new Error('Legacy fixture readback failed');
  }, { meetingId, status, changes });
}

async function localCueSnapshot(page, meetingId) {
  return page.evaluate(async (id) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const store = createIndexedDbLocalMeetingManifestStore();
    const [assigned, unassigned, authority] = await Promise.all([
      store.listCues(id), store.listUnassignedCues(id), store.inspectCueAuthority(id)
    ]);
    return { authority, assigned: assigned.map(({ cueId, cue }) => ({ cueId, cue })),
      unassigned: unassigned.map(({ cueId, revision, cue }) => ({ cueId, revision, cue })) };
  }, meetingId);
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

test('completed local Meeting reload exports both saved Cues', async ({ page }) => {
  const meetingId = 'EXPORT-RELOAD';
  let delayDetail = false;
  let releaseDetail;
  await installE2EAuth(page);
  await page.route(`**/api/meetings/${meetingId}`, async (route) => {
    if (delayDetail) await new Promise((resolve) => { releaseDetail = resolve; });
    await route.fulfill({ json: meetingDetail(meetingId) });
  });
  await page.goto('/');
  await saveUnassigned(page, meetingId, 'final', {
    cueId: 'cue-export-1', sequence: 1, translatedText: 'First local translation'
  });
  await saveUnassigned(page, meetingId, 'final', {
    cueId: 'cue-export-2', sequence: 2, startTimeMs: 1000, endTimeMs: 2000,
    translatedText: 'Second local translation'
  });
  await page.goto(`/#meeting-detail?meetingId=${meetingId}&from=history`);
  await expect(page.getByRole('heading', { name: `Meeting ${meetingId}` })).toBeVisible();
  delayDetail = true;
  await page.reload();
  await expect.poll(() => Boolean(releaseDetail)).toBe(true);
  releaseDetail();
  await expect(page.getByRole('heading', { name: `Meeting ${meetingId}` })).toBeVisible();
  await page.getByRole('navigation', { name: '會議內容目錄' })
    .getByRole('button', { name: '匯出' }).click();
  await expect(page.getByRole('region', { name: '本機字幕匯出' })
    .getByRole('button', { name: '開始匯出' })).toBeEnabled();
  expect(await exportedText(page)).toBe('First local translation\nSecond local translation\n');
  await page.getByLabel('字幕匯出格式').selectOption('srt');
  expect(await exportedText(page)).toBe('1\n00:00:00,000 --> 00:00:01,000\nFirst local translation\n\n2\n00:00:01,000 --> 00:00:02,000\nSecond local translation\n');
  await page.getByLabel('字幕匯出格式').selectOption('vtt');
  expect(await exportedText(page)).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nFirst local translation\n\n00:00:01.000 --> 00:00:02.000\nSecond local translation\n');
});

test('IndexedDB unassigned final Cues survive an A/B switch and reject failed reads', async ({ page }) => {
  await installE2EAuth(page);
  let conflictingB = false;
  let cloudExportCalls = 0;
  await page.route(/\/api\/meetings\/[^/]+\/exports(?:\/|$)/u, async (route) => {
    cloudExportCalls += 1;
    await route.fulfill({ status: 500 });
  });
  await page.route(/\/api\/meetings\/(A|B|C)$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const detail = meetingDetail(id);
    if (id === 'B' && conflictingB) detail.cues[0].translatedText = 'Conflicting B';
    await route.fulfill({ json: detail });
  });

  await page.goto('/');
  await saveUnassigned(page, 'A');
  await saveUnassigned(page, 'B');
  await saveUnassigned(page, 'B', 'final', { cueId: 'cue-B-local-only', sequence: 3,
    startTimeMs: 2000, endTimeMs: 3000, sourceText: 'Local source B',
    translatedText: 'Local translation B' });
  await saveUnassigned(page, 'B', 'partial', { cueId: 'cue-B-partial', sequence: 4,
    startTimeMs: 3000, endTimeMs: 4000, sourceText: 'Partial B', translatedText: 'Partial B' });
  await saveUnassigned(page, 'B', 'final', { cueId: 'cue-B-dismissed', sequence: 5,
    dismissed: true, startTimeMs: 4000, endTimeMs: 5000,
    sourceText: 'Dismissed B', translatedText: 'Dismissed B' });
  const localA = await localCueSnapshot(page, 'A');
  const localB = await localCueSnapshot(page, 'B');
  expect(localA.authority).toBe('legacy_readonly');
  expect(localB.authority).toBe('legacy_readonly');
  expect(localA.unassigned.map((record) => record.cueId)).toEqual(['cue-A']);
  expect(localB.unassigned.map((record) => record.cueId)).toEqual([
    'cue-B', 'cue-B-local-only', 'cue-B-partial', 'cue-B-dismissed'
  ]);
  expect(localB.assigned).toEqual([]);
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
  expect(bText.match(/Local translation B/g)).toHaveLength(1);
  expect(bText).toContain('Local translation B');
  expect(bText).not.toContain('Cloud changed B');
  expect(bText).not.toContain('Translation A');
  expect(bText).not.toContain('Partial B');
  expect(bText).not.toContain('Dismissed B');

  await openExport(page, 'C');
  await expect(page.getByRole('button', { name: '開始匯出' })).toBeDisabled();
  await expect(page.getByText('選擇的字幕內容尚無可匯出文字。')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  conflictingB = true;
  await openExport(page, 'A');
  const aText = await exportedText(page);
  expect(aText).toContain('Translation A');
  expect(aText).not.toContain('Translation B');
  await openExport(page, 'B');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const bAfterApiChange = await exportedText(page);
  expect(bAfterApiChange).toContain('Translation B');
  expect(bAfterApiChange).toContain('Local translation B');
  expect(bAfterApiChange).not.toContain('Conflicting B');
  expect(bAfterApiChange).not.toContain('Translation A');
  expect(await localCueSnapshot(page, 'A')).toEqual(localA);
  expect(await localCueSnapshot(page, 'B')).toEqual(localB);
  conflictingB = false;

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
  expect(cloudExportCalls).toBe(0);
});
