import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCueMutation } from '../../src/domain/subtitleCue/cueMutation.js';
import { cueRefinementInputHash } from '../../src/lib/cueContent.js';
import { createInMemoryLocalMeetingManifestStore } from '../../src/lib/localMeetingStorage.js';
import { createCueMutationCoordinator, cueMutationsForChange } from '../../src/lib/cueMutationCoordinator.js';
import { applyGlossaryCorrectionToCue } from '../../src/lib/glossaryReplacement.js';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { rolldown } from 'rolldown';
import { normalizeGeminiLiveCueEvents } from '../../src/lib/geminiLiveCueEvent.js';
import { applySubtitleCueEvent, createSubtitleCueState } from '../../src/lib/subtitleCues.js';

const base = () => {
  const cue = {
    cueId: 'cue-1', sessionId: 'session-1', segmentId: 'segment-1', sequence: 1,
    startTimeMs: 0, endTimeMs: 100, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
    sourceText: 'source', rawSource: 'source', sourceVersion: 1, sourceStatus: 'finalized',
    translatedText: 'translation', rawTranslation: 'translation', initialTranslation: 'translation',
    translationVersion: 1, translationStatus: 'finalized', status: 'final',
    finalizedReason: 'turnComplete', revision: 1, audioTurnId: 'turn-1', turnKey: 'turn-1',
    connectionEpoch: 1, providerEpoch: 1, providerEventSequence: 31,
    translationProvenance: { audioTurnId: 'turn-1', turnKey: 'turn-1',
      connectionEpoch: 1, providerEpoch: 1, eventSequence: 31 }
  };
  cue.refinement = { status: 'pending', version: 1, inputHash: cueRefinementInputHash(cue) };
  cue.refinedSource = null;
  cue.refinedTranslation = null;
  return cue;
};

const lateTranslation = (existing) => {
 const cue = {
  ...existing,
  translatedText: 'translation revised',
  rawTranslation: 'translation revised',
  initialTranslation: 'translation revised',
  translationVersion: existing.translationVersion + 1,
  providerEventSequence: 40,
  translationProvenance: { ...existing.translationProvenance, eventSequence: 40 }
 };
 cue.refinement = { status: 'pending', version: 1, inputHash: cueRefinementInputHash(cue) };
 cue.refinedTranslation = null;
 return cue;
};

test('Issue 41: Gemini output event 380 advances translation 5 to 6 after source 6', () => {
  const existing = { ...base(), sourceVersion: 6, translationVersion: 5,
    connectionEpoch: 5, providerEpoch: 1, providerEventSequence: 377,
    audioTurnId: 'audio-turn-5-4', turnKey: 'local:audio-turn-5-4',
    translationProvenance: { audioTurnId: 'audio-turn-5-4', turnKey: 'local:audio-turn-5-4',
      connectionEpoch: 5, providerEpoch: 1, eventSequence: 377 } };
  existing.refinement = { status: 'completed', version: 2,
    inputHash: cueRefinementInputHash(existing) };
  existing.refinedTranslation = 'older refined output';
  const [event] = normalizeGeminiLiveCueEvents({ serverContent: {
    outputTranscription: { text: 'translation revised' }
  } }, { sessionId: existing.sessionId, segmentId: existing.segmentId,
    connectionEpoch: 5, providerEpoch: 1, eventSequence: 380,
    translationAudioTurnId: existing.audioTurnId, translationTurnKey: existing.turnKey,
    sessionTimeMs: 110 });
  assert.equal(event.stream, 'translation');
  const proposed = applySubtitleCueEvent(createSubtitleCueState({ finalCues: [existing] }), event)
    .finalCues.find((cue) => cue.cueId === existing.cueId);
  assert.ok(proposed);
  assert.equal(proposed.sourceVersion, 6);
  assert.equal(proposed.translationVersion, 6);
  assert.equal(proposed.translationProvenance.eventSequence, 380);
  const accepted = applyCueMutation(existing, { side: 'translation', cue: proposed });
  assert.equal(accepted.status, 'committed');
  assert.equal(accepted.cue.sourceVersion, 6);
  assert.equal(accepted.cue.translationVersion, 6);
  assert.equal(accepted.cue.refinement?.status, 'pending');
  assert.equal(accepted.cue.refinedTranslation, null);

  for (const badProof of [
    { providerEpoch: null }, { eventSequence: 377 }, { audioTurnId: 'another-turn' }
  ]) {
    const rejected = applyCueMutation(existing, { side: 'translation', cue: {
      ...proposed, translationProvenance: { ...proposed.translationProvenance, ...badProof }
    } });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reason, 'cue_translation_event_unproven');
  }
  const unprovenCurrent = { ...existing, translationProvenance: {
    ...existing.translationProvenance, providerEpoch: null, eventSequence: null
  } };
  const rejected = applyCueMutation(unprovenCurrent, { side: 'translation', cue: proposed });
  assert.equal(rejected.reason, 'cue_translation_event_unproven');
  assert.equal(rejected.versionState.provenanceChecks.providerEpochsValid, false);
  assert.equal(rejected.versionState.provenanceChecks.eventSequencesValid, false);
});

test('final same-turn translation revision retains independent source version', () => {
  const existing = base();
  const result = applyCueMutation(existing, { side: 'translation', cue: lateTranslation(existing) });
  assert.equal(result.status, 'committed');
  assert.equal(result.cue.revision, 2);
  assert.equal(result.cue.sourceVersion, 1);
  assert.equal(result.cue.translationVersion, 2);
  assert.equal(result.cue.initialTranslation, 'translation revised');
  assert.equal(result.cue.refinement.inputHash, cueRefinementInputHash(result.cue));
});

test('late source event 38 followed by same-turn translation event 40 commits both sides', () => {
  const existing = base();
  const source = applyCueMutation(existing, { side: 'source', cue: {
    ...existing, sourceText: 'source extended', rawSource: 'source extended',
    sourceVersion: 2, providerEventSequence: 38,
    sourceProvenance: { audioTurnId: 'turn-1', turnKey: 'turn-1',
      connectionEpoch: 1, providerEpoch: 1, eventSequence: 38 }
  } });
  assert.equal(source.status, 'committed');
  assert.equal(source.cue.translationVersion, 1);
  const translation = applyCueMutation(source.cue, {
    side: 'translation', cue: lateTranslation(source.cue)
  });
  assert.equal(translation.status, 'committed');
  assert.equal(translation.cue.sourceVersion, 2);
  assert.equal(translation.cue.translationVersion, 2);
  assert.equal(translation.cue.providerEventSequence, 40);
});

test('non-prefix final correction needs a newer event from the same turn', () => {
  const existing = base();
  const correction = lateTranslation(existing);
  correction.translatedText = 'corrected output';
  correction.rawTranslation = 'corrected output';
  correction.initialTranslation = 'corrected output';
  correction.refinement = { status: 'pending', version: 1,
    inputHash: cueRefinementInputHash(correction) };
  const result = applyCueMutation(existing, { side: 'translation', cue: correction });
  assert.equal(result.status, 'committed');
  assert.equal(result.cue.translatedText, 'corrected output');
});

test('stale translation is rejected without overwriting a newer Cue', () => {
  const existing = base();
  const newer = applyCueMutation(existing, { side: 'translation', cue: lateTranslation(existing) });
  assert.equal(newer.status, 'committed');
  const stale = applyCueMutation(newer.cue, { side: 'translation', cue: {
    ...existing, translatedText: 'translation stale', translationVersion: 1
  } });
  assert.equal(stale.status, 'rejected');
  assert.equal(newer.cue.translatedText, 'translation revised');
  assert.equal(applyCueMutation(newer.cue, { side: 'translation', cue: {
    ...lateTranslation(existing), segmentId: 'other-segment',
    translatedText: 'other segment text', translationVersion: 3
  } }).reason, 'cue_identity_conflict');
  const crossTurn = applyCueMutation(newer.cue, { side: 'translation', cue: {
    ...lateTranslation(existing), translatedText: 'different turn', rawTranslation: 'different turn',
    translationVersion: 3,
    audioTurnId: 'turn-2', turnKey: 'turn-2', providerEventSequence: 41,
    translationProvenance: { audioTurnId: 'turn-2', turnKey: 'turn-2', connectionEpoch: 1,
      providerEpoch: 1, eventSequence: 41 }
  } });
  assert.equal(crossTurn.status, 'rejected', JSON.stringify(crossTurn));
});

test('out-of-order translation reports the first rejected versions without committing', () => {
  const existing = base();
  const older = lateTranslation(existing);
  older.providerEventSequence = 30;
  older.translationProvenance = { ...older.translationProvenance, eventSequence: 30 };
  const result = applyCueMutation(existing, { side: 'translation', cue: older });
  assert.equal(result.reason, 'cue_translation_event_unproven');
  assert.equal(result.versionState.expectedSideVersion, 2);
  assert.equal(result.versionState.currentTranslationVersion, 1);
  assert.equal(result.versionState.incomingTranslationVersion, 2);
  assert.equal(result.versionState.currentSideSequence, 31);
  assert.equal(result.versionState.incomingSideSequence, 30);
  assert.equal(existing.translatedText, 'translation');
  assert.equal(existing.revision, 1);
});

test('dictionary correction of async refinement does not fabricate a Gemini translation', async () => {
  const existing = base();
  existing.sourceText = '你好';
  existing.rawSource = '你好';
  existing.translatedText = 'Hello';
  existing.rawTranslation = 'Hello';
  existing.initialTranslation = 'Hello';
  existing.refinement = { status: 'pending', version: 1, inputHash: cueRefinementInputHash(existing) };
  const refined = { ...existing, refinedTranslation: 'Hello',
    refinement: { ...existing.refinement, status: 'completed', version: 2 } };
  const corrected = applyGlossaryCorrectionToCue(refined,
    [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }],
    { refineOnly: true });
  assert.equal(corrected.initialTranslation, 'Hello');
  assert.notEqual(corrected.refinedTranslation, refined.refinedTranslation);
  assert.deepEqual(cueMutationsForChange(existing, corrected).map(({ side }) => side), ['refinement']);
  let stored = existing;
  const coordinator = createCueMutationCoordinator({
    commit(job) {
      const result = applyCueMutation(stored, job);
      if (result.status === 'committed') stored = result.cue;
      return result;
    },
    createEventKey: () => 'refinement-1'
  });
  const [{ result: committed }] = await coordinator.enqueue({ meetingId: 'meeting-1',
    segmentId: existing.segmentId, changes: [{ before: existing, cue: corrected }] });
  assert.deepEqual(await coordinator.flush(), []);
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  assert.equal(stored.translationVersion, 1);
  assert.equal(stored.rawTranslation, 'Hello');
  assert.equal(stored.initialTranslation, 'Hello');
  assert.equal(stored.refinement.version, 3);
});

test('source-only same-turn final revision resets refinement before its queued mutation', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  let event = 0;
  const coordinator = createCueMutationCoordinator({
    commit: (job) => store.commitCueMutation(job), createEventKey: () => `source-reset-${++event}`
  });
  const existing = base();
  existing.sourceVersion = 7;
  existing.translationVersion = 7;
  existing.refinement = { ...existing.refinement, status: 'completed', version: 2 };
  existing.refinedSource = 'refined source';
  existing.refinedTranslation = 'refined translation';
  const next = { ...existing, sourceText: 'source revised', rawSource: 'source revised',
    sourceVersion: 8, providerEventSequence: 38,
    sourceProvenance: { audioTurnId: 'turn-1', turnKey: 'turn-1',
      connectionEpoch: 1, providerEpoch: 1, eventSequence: 38 },
    refinement: { status: 'pending', version: 1 }, refinedSource: null, refinedTranslation: null };
  next.refinement.inputHash = cueRefinementInputHash(next);
  await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: 'segment-1',
    changes: [{ before: null, cue: existing }] });
  const results = await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: 'segment-1',
    changes: [{ before: existing, cue: next }] });
  const summary = results.map(({ job, result }) => ({
    cueId: job.cue.cueId, segmentId: job.segmentId, turnId: job.cue.audioTurnId,
    mutationType: job.side, storedSourceVersion: existing.sourceVersion,
    proposedSourceVersion: job.cue.sourceVersion,
    storedTranslationVersion: existing.translationVersion,
    proposedTranslationVersion: job.cue.translationVersion,
    providerEventSequence: job.cue.providerEventSequence,
    inputHash: cueRefinementInputHash(job.cue),
    refinementInputHash: job.cue.refinement.inputHash,
    rejectionReason: result.reason ?? null
  }));
  assert.deepEqual(summary.map((entry) => entry.mutationType), ['source', 'refinement']);
  assert.equal(summary[0].inputHash, summary[0].refinementInputHash);
  assert.deepEqual(await coordinator.flush(), [], JSON.stringify(summary));
  const saved = (await store.listCues('meeting-1'))[0].cue;
  assert.equal(saved.sourceText, 'source revised');
  assert.equal(saved.sourceVersion, 8);
  assert.equal(saved.translationVersion, 7);
  assert.equal(saved.refinement.inputHash, next.refinement.inputHash);
});

test('consecutive refinement accepts new versions and rejects stale or conflicting payloads', () => {
  const initial = base();
  const queued = { ...initial, refinement: { ...initial.refinement, status: 'queued' } };
  const first = applyCueMutation(initial, { side: 'refinement', cue: queued });
  assert.equal(first.status, 'committed');
  const completed = { ...first.cue, refinement: { ...queued.refinement, status: 'completed' },
    refinedSource: 'first source', refinedTranslation: 'first translation' };
  const second = applyCueMutation(first.cue, { side: 'refinement', cue: completed });
  assert.equal(second.status, 'committed');
  const newer = { ...second.cue, refinement: { ...completed.refinement, version: 2,
    status: 'completed' }, refinedSource: 'second source', refinedTranslation: 'second translation' };
  const third = applyCueMutation(second.cue, { side: 'refinement', cue: newer });
  assert.equal(third.status, 'committed');
  assert.equal(applyCueMutation(third.cue, { side: 'refinement', cue: newer }).status, 'duplicate');
  const stale = applyCueMutation(third.cue, { side: 'refinement', cue: completed });
  assert.deepEqual([stale.status, stale.reason], ['rejected', 'versioned_state_regression']);
  const conflict = applyCueMutation(third.cue, { side: 'refinement', cue: {
    ...newer, refinedTranslation: 'different same-version translation'
  } });
  assert.deepEqual([conflict.status, conflict.reason], ['rejected', 'versioned_state_regression']);
  assert.equal(third.cue.refinedTranslation, 'second translation');
});

test('late refinement for prior input cannot overwrite a newer same-turn Final Cue', () => {
  const initial = base();
  const changed = { ...initial, sourceText: 'source revised', rawSource: 'source revised',
    sourceVersion: 2, providerEventSequence: 38,
    sourceProvenance: { audioTurnId: 'turn-1', turnKey: 'turn-1',
      connectionEpoch: 1, providerEpoch: 1, eventSequence: 38 },
    refinement: { status: 'pending', version: 1 }, refinedSource: null, refinedTranslation: null };
  changed.refinement.inputHash = cueRefinementInputHash(changed);
  const current = applyCueMutation(initial, { side: 'source', cue: changed });
  assert.equal(current.status, 'committed');
  const late = applyCueMutation(current.cue, { side: 'refinement', cue: {
    ...initial, refinement: { ...initial.refinement, status: 'completed', version: 3 },
    refinedSource: 'old source', refinedTranslation: 'old translation'
  } });
  assert.deepEqual([late.status, late.reason], ['rejected', 'cue_refinement_input_conflict']);
  assert.equal(current.cue.refinement.inputHash, changed.refinement.inputHash);
  assert.equal(current.cue.sourceVersion, 2);
});

test('same-turn source and translation changes reset refinement only after both sides advance', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  let event = 0;
  const coordinator = createCueMutationCoordinator({
    commit: (job) => store.commitCueMutation(job), createEventKey: () => `both-${++event}`
  });
  const initial = base();
  const next = { ...initial, sourceText: 'source revised', rawSource: 'source revised',
    sourceVersion: 2, translatedText: 'translation revised', rawTranslation: 'translation revised',
    initialTranslation: 'translation revised', translationVersion: 2,
    providerEventSequence: 40,
    sourceProvenance: { audioTurnId: 'turn-1', turnKey: 'turn-1',
      connectionEpoch: 1, providerEpoch: 1, eventSequence: 38 },
    translationProvenance: { audioTurnId: 'turn-1', turnKey: 'turn-1',
      connectionEpoch: 1, providerEpoch: 1, eventSequence: 40 },
    refinement: { status: 'pending', version: 1 }, refinedSource: null, refinedTranslation: null };
  next.refinement.inputHash = cueRefinementInputHash(next);
  await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: 'segment-1',
    changes: [{ before: null, cue: initial }] });
  const results = await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: 'segment-1',
    changes: [{ before: initial, cue: next }] });
  assert.deepEqual(results.map(({ job }) => job.side), ['source', 'translation', 'refinement']);
  assert.deepEqual(await coordinator.flush(), []);
  const saved = (await store.listCues('meeting-1'))[0].cue;
  assert.equal(saved.sourceVersion, 2);
  assert.equal(saved.translationVersion, 2);
  assert.equal(saved.refinement.inputHash, next.refinement.inputHash);
});

test('Pause-style mutation flush leaves only saved Cue and storage error blocks flush', async () => {
  const store = createInMemoryLocalMeetingManifestStore();
  let event = 0;
  const coordinator = createCueMutationCoordinator({
    commit: (job) => store.commitCueMutation(job), createEventKey: () => `event-${++event}`
  });
  const existing = base();
  await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: 'segment-1', changes: [{ before: null, cue: existing }] });
  await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: 'segment-1', changes: [
    { before: existing, cue: lateTranslation(existing) }
  ] });
  const flushed = await coordinator.flush();
  assert.deepEqual(flushed, []);
  const saved = await store.listCues('meeting-1');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].cue.translatedText, 'translation revised');
  assert.equal(saved[0].cue.sourceVersion, 1);
  const failing = createCueMutationCoordinator({
    commit: async () => { throw new Error('storage failed'); }, createEventKey: () => 'failure'
  });
  await failing.enqueue({ meetingId: 'meeting-1', segmentId: 'segment-1', changes: [{ before: null, cue: existing }] });
  assert.equal((await failing.flush())[0].error.message, 'storage failed');
});

test('local IndexedDB Cue and checkpoint survive reload after translation flush', async (t) => {
  const moduleUrl = async (path) => {
    const bundle = await rolldown({ input: fileURLToPath(new URL(path, import.meta.url)) });
    try {
      const { output } = await bundle.generate({ format: 'es' });
      return `data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`;
    } finally { await bundle.close(); }
  };
  const [storeUrl, coordinatorUrl, hashUrl] = await Promise.all([
    moduleUrl('../../src/lib/localMeetingStorage.js'),
    moduleUrl('../../src/lib/cueMutationCoordinator.js'),
    moduleUrl('../../src/lib/cueContent.js')
  ]);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://cue-regression.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://cue-regression.test/');
  const result = await page.evaluate(async ({ storeUrl, coordinatorUrl, hashUrl }) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import(storeUrl);
    const { createCueMutationCoordinator } = await import(coordinatorUrl);
    const { cueRefinementInputHash } = await import(hashUrl);
    window.fetch = () => { throw new Error('local-only boundary violated'); };
    const storeName = `translation-regression-${Date.now()}`;
    const store = createIndexedDbLocalMeetingManifestStore({ dbName: storeName });
    const cue = {
      cueId: 'cue-1', sessionId: 'session-1', segmentId: 'segment-1', sequence: 1,
      startTimeMs: 0, endTimeMs: 100, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
      sourceText: 'source', rawSource: 'source', sourceVersion: 1, sourceStatus: 'finalized',
      translatedText: 'translation', rawTranslation: 'translation', initialTranslation: 'translation',
      translationVersion: 1, translationStatus: 'finalized', status: 'final',
      finalizedReason: 'turnComplete', audioTurnId: 'turn-1', turnKey: 'turn-1',
      connectionEpoch: 1, providerEpoch: 1, providerEventSequence: 31,
      refinedSource: null, refinedTranslation: null
    };
    cue.refinement = { status: 'pending', version: 1, inputHash: cueRefinementInputHash(cue) };
    const revised = { ...cue, translatedText: 'translation revised',
      rawTranslation: 'translation revised', initialTranslation: 'translation revised',
      translationVersion: 2, providerEventSequence: 40,
      translationProvenance: { audioTurnId: 'turn-1', turnKey: 'turn-1',
        connectionEpoch: 1, providerEpoch: 1, eventSequence: 40 } };
    revised.refinement = { status: 'pending', version: 1, inputHash: cueRefinementInputHash(revised) };
    let event = 0;
    const coordinator = createCueMutationCoordinator({
      commit: (job) => store.commitCueMutation(job), createEventKey: () => `event-${++event}`
    });
    await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: 'segment-1',
      changes: [{ before: null, cue }] });
    await coordinator.enqueue({ meetingId: 'meeting-1', segmentId: 'segment-1',
      changes: [{ before: cue, cue: revised }] });
    const failures = await coordinator.flush();
    const reloaded = createIndexedDbLocalMeetingManifestStore({ dbName: storeName });
    return { failures, cues: await reloaded.listCues('meeting-1'),
      checkpoint: await reloaded.getCheckpoint('meeting-1', 'segment-1') };
  }, { storeUrl, coordinatorUrl, hashUrl });
  assert.deepEqual(result.failures, []);
  assert.equal(result.cues.length, 1);
  assert.equal(result.cues[0].cue.translatedText, 'translation revised');
  assert.equal(result.cues[0].cue.sourceVersion, 1);
  assert.equal(result.cues[0].cue.translationVersion, 2);
  assert.equal(result.checkpoint.checkpoint.cueCursor.commitCount, 2);
  assert.equal(result.checkpoint.checkpoint.cueCursor.sequence, 1);
});
