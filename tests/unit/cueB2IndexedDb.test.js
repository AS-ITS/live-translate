import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { rolldown } from 'rolldown';

test('B2 IndexedDB commits Cue and cursor atomically across reload', async (t) => {
  const bundle = await rolldown({
    input: fileURLToPath(new URL('../../src/lib/localMeetingStorage.js', import.meta.url))
  });
  let source;
  try {
    const { output } = await bundle.generate({ format: 'es' });
    source = output[0].code;
  } finally {
    await bundle.close();
  }
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://cue-b2.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://cue-b2.test/');
  const args = { moduleUrl: `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
    dbName: `cue-b2-${Date.now()}` };
  const committed = await page.evaluate(async ({ moduleUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    const cue = { cueId: 'cue-1', sessionId: 'session-1', segmentId: 'segment-1',
      sequence: 1, startTimeMs: 0, endTimeMs: 100,
      sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', sourceText: 'hello',
      translatedText: 'world', sourceVersion: 1, translationVersion: 1,
      sourceStatus: 'finalized', translationStatus: 'finalized', status: 'final',
      finalizedReason: 'final' };
    const input = { meetingId: 'meeting-1', segmentId: 'segment-1',
      eventKey: 'event-1', side: 'auto', cue };
    const first = await store.commitCueMutation(input);
    const duplicate = await store.commitCueMutation(input);
    return { first, duplicate, checkpoint: await store.getCheckpoint('meeting-1', 'segment-1') };
  }, args);
  assert.equal(committed.first.status, 'committed');
  assert.equal(committed.duplicate.status, 'duplicate');
  assert.equal(committed.checkpoint.checkpoint.cueCursor.commitCount, 1);
  assert.deepEqual(committed.checkpoint.checkpoint.finalCues, []);
  await page.reload();
  const recovered = await page.evaluate(async ({ moduleUrl, dbName }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
    return { cues: await store.listCues('meeting-1'),
      checkpoint: await store.getCheckpoint('meeting-1', 'segment-1') };
  }, args);
  assert.equal(recovered.cues[0].cue.revision, 1);
  assert.equal(recovered.checkpoint.checkpoint.cueCursor.commitCount, 1);
});
