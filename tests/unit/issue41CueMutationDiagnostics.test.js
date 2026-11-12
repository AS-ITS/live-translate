import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { rolldown } from 'rolldown';
import { createCueMutationCoordinator } from '../../src/lib/cueMutationCoordinator.js';
import { describeCueMutationBatch, describeCueMutationFailures } from '../../src/lib/cueMutationFailureDiagnostics.js';
import { observePauseStage } from '../../src/features/live/pauseStageDiagnostics.js';
import { commitLocalRolloverAfterDurableBarrier } from '../../src/features/live/useLiveRecordingController.js';
import {
  captureCueMutationConsole, createCueMutationDiagnostics, writeCueMutationArtifact
} from '../e2e/issue41CueMutationDiagnostics.js';

const job = (cueId) => ({ before: null, cue: { cueId, sourceText: 'SECRET_CUE_TEXT' } });
const capture = (failures) => {
  const diagnostics = createCueMutationDiagnostics();
  captureCueMutationConsole({ text: () => `ISSUE41_CUE_MUTATION ${JSON.stringify({
    failures: describeCueMutationFailures(failures)
  })}` }, diagnostics);
  const path = join(mkdtempSync(join(tmpdir(), 'issue41-cue-mutation-')), 'cue-mutation-diagnostics.json');
  writeCueMutationArtifact(path, diagnostics, 'failed');
  const text = readFileSync(path, 'utf8');
  assert.doesNotMatch(text, /SECRET_CUE_TEXT|secret-token|secret-key/u);
  return JSON.parse(text);
};

test('rejected mutation records the batch count, failed index and safe reason in independent evidence', async () => {
  const coordinator = createCueMutationCoordinator({
    commit: async ({ cue }) => cue.cueId === 'second'
      ? { status: 'rejected', reason: 'cue_stale_or_same_side_version' }
      : { status: 'committed', cue },
    createEventKey: () => 'event'
  });
  await coordinator.enqueue({ meetingId: 'meeting', segmentId: 'segment', changes: [job('first'), job('second')] });
  const failures = await coordinator.flush();
  assert.equal(failures.length, 1);
  const artifact = capture(failures);
  assert.equal(artifact.testStatus, 'failed');
  assert.deepEqual(artifact.failures[0], {
    operation: 'LOCAL_CUE_MUTATION_FLUSH', failureStage: null,
    cueId: 'second', segmentId: 'segment', operationId: 'event', mutationOperation: 'initial',
    mutationCount: 2, mutationIndex: 1, failureCount: 1, failureIndex: 0,
    resultStatus: 'rejected', resultReason: 'cue_stale_or_same_side_version', versionState: null,
    errorName: null, errorCode: null, stackSummary: [],
    rootErrorName: null, rootErrorCode: null, rootStackSummary: [], transactionState: null,
    classification: 'MUTATION_REJECTED'
  });
});

test('batch diagnostics retain index zero ACK without cue text or tokens', () => {
  const batch = describeCueMutationBatch([
    { job: { side: 'translation', eventKey: 'operation-0', cue: {
      translationVersion: 1, translationProvenance: { eventSequence: 2 },
      refinement: { inputHash: 'cue-input:1234' }, translatedText: 'SECRET_CUE_TEXT'
    } }, result: { status: 'committed', cue: {
      translationVersion: 2, translationProvenance: { eventSequence: 2 },
      refinement: { inputHash: 'cue-input:5678' }, translatedText: 'SECRET_CUE_TEXT'
    } } },
    { job: { side: 'refinement', eventKey: 'operation-1', cue: {} },
      result: { status: 'rejected', reason: 'cue_refinement_input_conflict' } }
  ]);
  const diagnostics = createCueMutationDiagnostics();
  captureCueMutationConsole({ text: () => `ISSUE41_CUE_MUTATION ${JSON.stringify({
    batch, failures: describeCueMutationFailures([{ job: { side: 'refinement', eventKey: 'operation-1', cue: {} },
      result: { status: 'rejected', reason: 'cue_refinement_input_conflict' }, mutationCount: 2, mutationIndex: 1 }])
  })}` }, diagnostics);
  assert.equal(diagnostics[0].batch[0].resultStatus, 'committed');
  assert.equal(diagnostics[0].batch[0].committedTranslationVersion, 2);
  assert.equal(diagnostics[0].batch[1].resultReason, 'cue_refinement_input_conflict');
  assert.doesNotMatch(JSON.stringify(diagnostics), /SECRET_CUE_TEXT/u);
});

test('version regression diagnostics retain numeric versions and redact unsafe turn IDs', () => {
  const artifact = capture([{ job: {
    side: 'translation', segmentId: 'segment-1', cue: { cueId: 'cue-1', translatedText: 'SECRET_CUE_TEXT' }
  }, result: { status: 'rejected', reason: 'versioned_state_regression', versionState: {
    currentRevision: 8, incomingRevision: 9, currentSourceVersion: 3,
    incomingSourceVersion: 2, currentTranslationVersion: 4,
    incomingTranslationVersion: 4, currentProviderSequence: 51,
    incomingProviderSequence: 49, currentTurnId: 'turn-1',
    incomingTurnId: 'unsafe turn SECRET_CUE_TEXT'
  } }, mutationCount: 2, mutationIndex: 1, stage: 'queue_reject' }]);
  assert.equal(artifact.failures[0].versionState.currentSourceVersion, 3);
  assert.equal(artifact.failures[0].versionState.incomingSourceVersion, 2);
  assert.equal(artifact.failures[0].versionState.currentProviderSequence, 51);
  assert.equal(artifact.failures[0].versionState.incomingTurnId, null);
  assert.equal(artifact.failures[0].classification, 'MUTATION_REJECTED');
});

test('thrown IndexedDB error captures safe class, code and application frames without its message', async () => {
  const error = new Error('secret-token secret-key');
  error.name = 'AbortError';
  error.code = 'IDB_ABORT';
  error.stack = 'AbortError: secret-token\n    at runNamedTransaction (http://localhost:5173/src/lib/localMeetingStorage.js?t=secret-key:1966:4)\n    at user secret-token';
  const coordinator = createCueMutationCoordinator({
    commit: async () => { throw error; }, createEventKey: () => 'event'
  });
  await coordinator.enqueue({ meetingId: 'meeting', segmentId: 'segment', changes: [job('first')] });
  const artifact = capture(await coordinator.flush());
  assert.deepEqual(artifact.failures[0], {
    operation: 'LOCAL_CUE_MUTATION_FLUSH', failureStage: null,
    cueId: 'first', segmentId: 'segment', operationId: 'event', mutationOperation: 'initial',
    mutationCount: 1, mutationIndex: 0, failureCount: 1, failureIndex: 0,
    resultStatus: null, resultReason: null, versionState: null,
    errorName: 'AbortError', errorCode: 'IDB_ABORT',
    stackSummary: ['src/lib/localMeetingStorage.js:1966:4'],
    rootErrorName: 'AbortError', rootErrorCode: 'IDB_ABORT',
    rootStackSummary: ['src/lib/localMeetingStorage.js:1966:4'], transactionState: null,
    classification: 'INDEXEDDB_TRANSACTION_FAILURE'
  });
});

test('other commit exceptions and unknown failures remain visibly failed', async () => {
  const coordinator = createCueMutationCoordinator({
    commit: async () => { throw new Error('secret-token'); }, createEventKey: () => 'event'
  });
  await coordinator.enqueue({ meetingId: 'meeting', segmentId: 'segment', changes: [job('first')] });
  assert.equal(capture(await coordinator.flush()).failures[0].classification, 'COMMIT_EXCEPTION');
  assert.equal(capture([{ error: new Error('secret-token') }]).failures[0].classification, 'UNCLASSIFIED_ERROR');
  const sensitive = new Error('secret-token');
  sensitive.name = 'secret-token';
  sensitive.code = 'secret-key';
  const redacted = capture([{ job: { side: 'initial' }, result: { status: 'rejected', reason: 'secret-token' },
    error: sensitive, mutationCount: 1, mutationIndex: 0 }]).failures[0];
  assert.equal(redacted.resultReason, null);
  assert.equal(redacted.errorName, null);
  assert.equal(redacted.errorCode, null);
});

test('IndexedDB transaction fallback Error is distinguished from a generic commit exception', () => {
  const failure = describeCueMutationFailures([{ job: { side: 'initial' },
    error: new Error('IndexedDB transaction failed.'), mutationCount: 1, mutationIndex: 0 }]);
  assert.equal(failure[0].classification, 'INDEXEDDB_TRANSACTION_FAILURE');
  assert.equal(failure[0].errorName, 'Error');
  assert.equal(capture([{ job: { side: 'initial' }, error: Object.assign(new Error('secret-token'),
    { name: 'AbortError', code: 20 }) }]).failures[0].errorCode, 20);
  assert.equal(describeCueMutationFailures([{ job: { side: 'source' },
    result: { status: 'rejected', reason: 'payload_conflict' } }])[0].resultReason, 'payload_conflict');
});

test('first queue rejection is captured before wrapping and preserves earlier committed Cue', async () => {
  const saved = [];
  const firstFailures = [];
  const coordinator = createCueMutationCoordinator({
    createEventKey: () => 'operation-1',
    commit: async ({ cue }) => cue.cueId === 'conflict'
      ? { status: 'rejected', reason: 'payload_conflict' }
      : (saved.push(cue.cueId), { status: 'committed', cue }),
    onReject: (result, mutation, stage) => firstFailures.push(
      capture([{ job: mutation, result, stage }]).failures[0])
  });
  const results = await coordinator.enqueue({ meetingId: 'meeting', segmentId: 'segment',
    changes: [job('saved'), job('conflict')] });
  assert.deepEqual(saved, ['saved']);
  assert.equal(results[1].result.status, 'rejected');
  assert.deepEqual(firstFailures.map(({ failureStage, cueId, segmentId, operationId, resultReason }) =>
    [failureStage, cueId, segmentId, operationId, resultReason]),
  [['commit', 'conflict', 'segment', 'operation-1', 'payload_conflict']]);
  assert.equal((await coordinator.flush()).length, 1);
});

test('Cue queue failure aborts Pause and Rollover barriers without committing transition', async () => {
  const root = new Error('secret-token');
  root.name = 'AbortError';
  root.stack = 'AbortError: secret-token\n    at request (http://localhost:5173/src/lib/localMeetingStorage.js:1958:2)';
  const wrapped = new Error('One or more Local Cue mutations were not committed.', { cause: root });
  const diagnostic = capture([{ stage: 'queue_reject', job: {
    side: 'initial', cue: { cueId: 'cue-1' }, segmentId: 'segment-1', eventKey: 'operation-1'
  }, error: wrapped }]).failures[0];
  assert.equal(diagnostic.rootErrorName, 'AbortError');
  assert.deepEqual(diagnostic.rootStackSummary, ['src/lib/localMeetingStorage.js:1958:2']);
  let pauseCommitted = false;
  const pause = async () => {
    await observePauseStage('CUE_PUBLISH_FLUSH', async () => { throw wrapped; });
    pauseCommitted = true;
  };
  await assert.rejects(pause(),
    /One or more Local Cue/u);
  assert.equal(pauseCommitted, false);
  let rolloverCommitted = false;
  await assert.rejects(commitLocalRolloverAfterDurableBarrier({
    flushCheckpoint: async () => { throw wrapped; },
    sealAudioContainer: async () => {}, sealSegmentWrites: async () => {},
    sealPcmJournal: async () => null,
    commitSegment: async () => { rolloverCommitted = true; }
  }), /One or more Local Cue/u);
  assert.equal(rolloverCommitted, false);
});

test('Chromium IndexedDB abort keeps pending Cue absent and exposes original transaction failure', async (t) => {
  const bundle = await rolldown({ input: fileURLToPath(new URL('../../src/lib/localMeetingStorage.js', import.meta.url)) });
  const { output } = await bundle.generate({ format: 'es' });
  await bundle.close();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://cue-fault.test/', (route) => route.fulfill({ body: '<!doctype html>' }));
  await page.goto('https://cue-fault.test/');
  const result = await page.evaluate(async (moduleUrl) => {
    const { createIndexedDbLocalMeetingManifestStore, localTransactionFailureState } = await import(moduleUrl);
    const store = createIndexedDbLocalMeetingManifestStore({ dbName: `cue-fault-${Date.now()}` });
    await store.listPendingCues('meeting-1');
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const transaction = original.apply(this, args);
      if (Array.isArray(args[0]) && args[0].includes('cues') && args[1] === 'readwrite') {
        queueMicrotask(() => transaction.abort());
      }
      return transaction;
    };
    let error;
    try {
      await store.commitCueMutation({ meetingId: 'meeting-1', side: 'pending', eventKey: 'operation-1',
        cue: { cueId: 'cue-1', sessionId: 'session-1', sequence: 1, startTimeMs: 0,
          endTimeMs: 100, status: 'final', sourceText: 'SECRET_CUE_TEXT' } });
    } catch (caught) { error = { name: caught.name, state: localTransactionFailureState(caught) }; }
    IDBDatabase.prototype.transaction = original;
    return { error, pending: (await store.listPendingCues('meeting-1')).length };
  }, `data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`);
  assert.equal(result.error?.name, 'AbortError');
  assert.equal(result.error?.state, 'aborted');
  assert.equal(result.pending, 0);
});
