import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { rolldown } from 'rolldown';
import { applyGlossaryCorrectionToCue } from '../../src/lib/glossaryReplacement.js';
import { effectiveTranslationForCue } from '../../src/lib/cueContent.js';
import { createCueMutationCoordinator } from '../../src/lib/cueMutationCoordinator.js';
import { mergeMeetingDetailWithLocalCues } from '../../src/lib/meetingLocalTranscript.js';
import { mergeHostViewerEnvelope } from '../../src/lib/hostViewerAuthority.js';
import { cueListForDisplay } from '../../src/lib/cueUi.js';
import { publishCommittedLocalCues } from '../../src/webrtc/useWebRtcDeviceSidecar.js';

async function storageModuleUrl() {
  const bundle = await rolldown({ input: fileURLToPath(new URL('../../src/lib/localMeetingStorage.js', import.meta.url)) });
  try {
    const { output } = await bundle.generate({ format: 'es' });
    return `data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`;
  } finally {
    await bundle.close();
  }
}

function providerCue(id) {
  return {
    cueId: id, sessionId: 'session-1', segmentId: 'segment-1', sequence: 1,
    startTimeMs: 0, endTimeMs: 100, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
    sourceText: '你好。', rawSource: '你好。',
    translatedText: 'Hello.', rawTranslation: 'Hello.',
    initialTranslation: 'Hello.', sourceVersion: 1, translationVersion: 1,
    translationProvenance: { eventSequence: 2, connectionEpoch: 1, providerEpoch: 1 },
    sourceStatus: 'finalized', translationStatus: 'finalized', status: 'final'
  };
}

test('dictionary Cue Writer ACK, IndexedDB readback, Host reload and Viewer agree; failures stay isolated', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://dictionary-local.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://dictionary-local.test/');
  const moduleUrl = await storageModuleUrl();

  for (const scenario of ['matched', 'no-match', 'dictionary-throws', 'writer-fails']) {
    const dbName = `dictionary-cue-${scenario}-${Date.now()}`;
    const original = providerCue(`cue-${scenario}`);
    let corrected = original;
    try {
      const entries = scenario === 'dictionary-throws'
        ? [{ get source() { throw new Error('dictionary failed'); } }]
        : [{ source: scenario === 'no-match' ? '再見' : '你好', target: 'su3cl3' }];
      corrected = applyGlossaryCorrectionToCue(original, entries);
    } catch (error) {
      assert.equal(scenario, 'dictionary-throws');
      assert.match(error.message, /dictionary failed/);
    }
    if (scenario === 'matched') {
      assert.equal(corrected.rawSource, '你好。');
      assert.equal(corrected.initialTranslation, 'Hello.');
      assert.equal(effectiveTranslationForCue(corrected), 'su3cl3');
    }

    const acks = [];
    const ackVisible = [];
    let key = 0;
    const coordinator = createCueMutationCoordinator({
      createEventKey: () => `event-${++key}`,
      commit: (job) => page.evaluate(async ({ moduleUrl, dbName, job, fail }) => {
        const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
        const store = createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName });
        if (!fail) return store.commitCueMutation(job);
        const originalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          if (this.name === 'cues') throw new Error('SIMULATED_CUE_WRITE_FAILURE');
          return originalPut.apply(this, args);
        };
        try { return await store.commitCueMutation(job); }
        finally { IDBObjectStore.prototype.put = originalPut; }
      }, { moduleUrl, dbName, job, fail: scenario === 'writer-fails' }),
      onAck: (result) => { acks.push(result); ackVisible.push(result.cue); }
    });
    const results = await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: 'segment-1',
      changes: [{ before: null, cue: corrected }] });
    if (scenario === 'writer-fails') {
      assert.equal(acks.length, 0, 'Writer must not ACK a failed transaction');
      assert.equal(ackVisible.length, 0, 'ACK-gated Host state must stay empty');
      assert.ok(results[0].error, 'Writer failure must be visible');
    } else {
      assert.equal(results[0].result.status, 'committed', 'Writer ACK');
      assert.equal(acks.length, 1, 'ACK callback');
      assert.equal(ackVisible.length, 1, 'Host receives committed Cue after ACK');
    }

    await page.reload();
    const records = await page.evaluate(async ({ moduleUrl, dbName }) => {
      const { createIndexedDbLocalMeetingManifestStore } = await import(moduleUrl);
      return createIndexedDbLocalMeetingManifestStore({ indexedDBImpl: indexedDB, dbName }).listCues('meeting-1');
    }, { moduleUrl, dbName });
    if (scenario === 'writer-fails') {
      assert.deepEqual(records, [], 'failed transaction must leave no durable Cue');
      assert.deepEqual(publishCommittedLocalCues('meeting-1', records, () => {
        assert.fail('failed Cue must not reach transport');
      }), []);
      continue;
    }
    assert.equal(records.length, 1, 'IndexedDB readback after page reload');
    const persisted = records[0].cue;
    const expected = scenario === 'matched' ? 'su3cl3' : 'Hello.';
    assert.equal(persisted.rawSource, '你好。', 'source remains unchanged after readback');
    assert.equal(effectiveTranslationForCue(persisted), expected, 'persisted effective translation');

    const host = mergeMeetingDetailWithLocalCues({ meeting: { id: 'meeting-1' }, cues: [] }, records,
      { authoritative: true });
    assert.equal(host.readingContent.translationArticle.text, expected, 'Host hydrated transcript');
    assert.equal(effectiveTranslationForCue(cueListForDisplay({ finalCues: host.cues })[0]), expected,
      'Host Cue display projection after reload');

    const transportReceived = [];
    const committedCues = publishCommittedLocalCues('meeting-1', records,
      (cue) => transportReceived.push(cue));
    assert.equal(committedCues.length, 1);
    assert.equal(transportReceived.length, 1, 'Viewer transport receives persisted Cue');
    const viewerBase = { meeting: { id: 'meeting-1' }, cues: [] };
    const envelopeCue = transportReceived[0];
    const snapshot = mergeHostViewerEnvelope(viewerBase, { type: 'snapshot', meetingId: 'meeting-1',
      sourceId: 'host-1', sequence: 1, cues: [envelopeCue] });
    assert.equal(effectiveTranslationForCue(snapshot.cues[0]), expected, 'Viewer snapshot');
    const appended = mergeHostViewerEnvelope(viewerBase, { type: 'cue.append', meetingId: 'meeting-1',
      sourceId: 'host-1', sequence: 1, cue: envelopeCue });
    assert.equal(effectiveTranslationForCue(appended.cues[0]), expected, 'Viewer append');
    const updated = mergeHostViewerEnvelope(appended, { type: 'cue.update', meetingId: 'meeting-1',
      sourceId: 'host-1', sequence: 2, cue: { ...envelopeCue, revision: persisted.revision + 1 } });
    assert.equal(effectiveTranslationForCue(updated.cues[0]), expected, 'Viewer update');
  }
});
