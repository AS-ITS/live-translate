import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { rolldown } from 'rolldown';

async function moduleUrl(path) {
  const bundle = await rolldown({ input: fileURLToPath(new URL(path, import.meta.url)) });
  try {
    const { output } = await bundle.generate({ format: 'es' });
    return `data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`;
  } finally {
    await bundle.close();
  }
}

test('formal Cue coordinator commits independent sides and isolates one rejected Cue in IndexedDB', async (t) => {
  const [storeUrl, coordinatorUrl] = await Promise.all([
    moduleUrl('../../src/lib/localMeetingStorage.js'),
    moduleUrl('../../src/lib/cueMutationCoordinator.js')
  ]);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://cue-b2-formal.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://cue-b2-formal.test/');
  const result = await page.evaluate(async ({ storeUrl, coordinatorUrl }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(storeUrl);
    const { createCueMutationCoordinator } = await import(coordinatorUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ dbName: `b2-formal-${Date.now()}` });
    let event = 0;
    const coordinator = createCueMutationCoordinator({
      commit: (mutation) => store.commitCueMutation(mutation),
      createEventKey: () => `event-${++event}`
    });
    const base = { cueId: 'cue-1', sessionId: 'session-1', segmentId: 'segment-1',
      sequence: 1, startTimeMs: 0, endTimeMs: 100, sourceLanguageCode: 'zh-Hant',
      targetLanguageCode: 'en', sourceText: 'hello', translatedText: 'world',
      sourceVersion: 1, translationVersion: 1, sourceStatus: 'finalized',
      translationStatus: 'finalized', status: 'final', finalizedReason: 'final' };
    const first = await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: 'segment-1',
      changes: [{ cue: base }] });
    const source = { ...base, sourceText: 'hello there', sourceVersion: 2 };
    const sourceResult = await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: 'segment-1',
      changes: [{ before: base, cue: source }] });
    const translation = { ...source, translatedText: 'world again', translationVersion: 2 };
    const translationResult = await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: 'segment-1',
      changes: [{ before: source, cue: translation }] });
    const conflict = { ...base, cueId: 'cue-conflict', sequence: 1 };
    const independent = { ...base, cueId: 'cue-2', sequence: 2 };
    const isolated = await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: 'segment-1',
      changes: [{ cue: conflict }, { cue: independent }] });
    const unresolved = await coordinator.flush();
    const cues = await store.listCues('meeting-1');
    const checkpoint = await store.getCheckpoint('meeting-1', 'segment-1');
    return { first: first.map((x) => x.result), source: sourceResult.map((x) => x.result),
      translation: translationResult.map((x) => x.result), isolated: isolated.map((x) => x.result),
      unresolved: unresolved.map((x) => x.result?.reason),
      cues: cues.map((x) => x.cue), cursor: checkpoint.checkpoint.cueCursor,
      checkpointCues: checkpoint.checkpoint.finalCues };
  }, { storeUrl, coordinatorUrl });
  assert.equal(result.first[0].status, 'committed');
  assert.equal(result.source[0].status, 'committed');
  assert.equal(result.translation[0].status, 'committed');
  assert.equal(result.isolated[0].status, 'rejected');
  assert.equal(result.isolated[1].status, 'committed');
  assert.deepEqual(result.unresolved, ['cue_sequence_owner_conflict']);
  assert.equal(result.cues.length, 2);
  assert.equal(result.cues.find((cue) => cue.cueId === 'cue-1').sourceText, 'hello there');
  assert.equal(result.cues.find((cue) => cue.cueId === 'cue-1').translatedText, 'world again');
  assert.equal(result.cursor.sequence, 2);
  assert.equal(result.cursor.commitCount, 4);
  assert.deepEqual(result.checkpointCues, []);
});
