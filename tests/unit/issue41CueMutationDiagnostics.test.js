import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCueMutationCoordinator } from '../../src/lib/cueMutationCoordinator.js';
import { describeCueMutationFailures } from '../../src/lib/cueMutationFailureDiagnostics.js';
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
    operation: 'LOCAL_CUE_MUTATION_FLUSH', mutationOperation: 'initial',
    mutationCount: 2, mutationIndex: 1, failureCount: 1, failureIndex: 0,
    resultStatus: 'rejected', resultReason: 'cue_stale_or_same_side_version',
    errorName: null, errorCode: null, stackSummary: [], classification: 'MUTATION_REJECTED'
  });
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
    operation: 'LOCAL_CUE_MUTATION_FLUSH', mutationOperation: 'initial',
    mutationCount: 1, mutationIndex: 0, failureCount: 1, failureIndex: 0,
    resultStatus: null, resultReason: null, errorName: 'AbortError', errorCode: 'IDB_ABORT',
    stackSummary: ['src/lib/localMeetingStorage.js:1966:4'],
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
