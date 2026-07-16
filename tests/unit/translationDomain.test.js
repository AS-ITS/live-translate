import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRANSLATION_EXECUTION_STATUSES,
  TranslationExecution,
  TranslationOutput,
  TranslationRequest
} from '../../src/domain/translation/index.js';

test('TranslationRequest constructs a valid immutable request', () => {
  const request = new TranslationRequest({
    id: 'request-1',
    sessionId: 'session-1',
    sourceTranscriptRevisionId: 'source-revision-1',
    targetLanguageCode: 'zh-Hant',
    createdAt: '2026-07-13T08:00:00.000Z'
  });

  assert.equal(request.id, 'request-1');
  assert.equal(request.sessionId, 'session-1');
  assert.equal(request.sourceTranscriptRevisionId, 'source-revision-1');
  assert.equal(request.targetLanguageCode, 'zh-Hant');
  assert.equal(request.createdAt, '2026-07-13T08:00:00.000Z');
  assert.equal(request.sourceTranscriptSnapshot, null);
  assert.equal(Object.isFrozen(request), true);
});

test('TranslationRequest rejects missing required dependency or value', () => {
  assert.throws(() => new TranslationRequest(), /id/);
  assert.throws(
    () =>
      new TranslationRequest({
        id: 'request-1',
        sessionId: 'session-1',
        sourceTranscriptRevisionId: 'source-revision-1',
        targetLanguageCode: 'ja'
      }),
    /createdAt/
  );
});

test('TranslationRequest rejects empty IDs and target language code', () => {
  assert.throws(
    () =>
      new TranslationRequest({
        id: '',
        sessionId: 'session-1',
        sourceTranscriptRevisionId: 'source-revision-1',
        targetLanguageCode: 'ja',
        createdAt: 1000
      }),
    /id/
  );
  assert.throws(
    () =>
      new TranslationRequest({
        id: 'request-1',
        sessionId: ' ',
        sourceTranscriptRevisionId: 'source-revision-1',
        targetLanguageCode: 'ja',
        createdAt: 1000
      }),
    /sessionId/
  );
  assert.throws(
    () =>
      new TranslationRequest({
        id: 'request-1',
        sessionId: 'session-1',
        sourceTranscriptRevisionId: '',
        targetLanguageCode: 'ja',
        createdAt: 1000
      }),
    /sourceTranscriptRevisionId/
  );
  assert.throws(
    () =>
      new TranslationRequest({
        id: 'request-1',
        sessionId: 'session-1',
        sourceTranscriptRevisionId: 'source-revision-1',
        targetLanguageCode: '',
        createdAt: 1000
      }),
    /targetLanguageCode/
  );
});

test('TranslationRequest input object mutation does not affect created object', () => {
  const snapshot = {
    revisionId: 'source-revision-1',
    items: [{ text: 'hello', sequence: 0 }]
  };
  const request = new TranslationRequest({
    id: 'request-1',
    sessionId: 'session-1',
    sourceTranscriptRevisionId: 'source-revision-1',
    sourceTranscriptSnapshot: snapshot,
    targetLanguageCode: 'ZH-hant-custom',
    createdAt: 1000
  });

  snapshot.revisionId = 'changed';
  snapshot.items[0].text = 'changed';
  snapshot.items.push({ text: 'later', sequence: 1 });

  assert.equal(request.targetLanguageCode, 'ZH-hant-custom');
  assert.deepEqual(request.sourceTranscriptSnapshot, {
    revisionId: 'source-revision-1',
    items: [{ text: 'hello', sequence: 0 }]
  });
});

test('TranslationRequest returned nested values cannot modify domain state', () => {
  const request = new TranslationRequest({
    id: 'request-1',
    sessionId: 'session-1',
    sourceTranscriptRevisionId: 'source-revision-1',
    sourceTranscriptSnapshot: {
      revisionId: 'source-revision-1',
      items: [{ text: 'hello', sequence: 0 }]
    },
    targetLanguageCode: 'ja',
    createdAt: 1000
  });

  assert.throws(() => {
    request.sourceTranscriptSnapshot.items[0].text = 'changed';
  }, TypeError);
  assert.throws(() => {
    request.sourceTranscriptSnapshot.items.push({ text: 'later', sequence: 1 });
  }, TypeError);
  assert.equal(request.sourceTranscriptSnapshot.items[0].text, 'hello');
  assert.equal(request.sourceTranscriptSnapshot.items.length, 1);
});

test('TranslationExecution constructs a valid initial execution', () => {
  const execution = new TranslationExecution({
    id: 'execution-1',
    translationRequestId: 'request-1',
    startedAt: 1000
  });

  assert.equal(execution.id, 'execution-1');
  assert.equal(execution.translationRequestId, 'request-1');
  assert.equal(execution.status, 'pending');
  assert.equal(execution.providerKey, undefined);
  assert.equal(execution.startedAt, 1000);
  assert.equal(execution.completedAt, null);
  assert.equal(execution.failureInfo, null);
  assert.deepEqual(TRANSLATION_EXECUTION_STATUSES, ['pending', 'running', 'completed', 'failed', 'cancelled']);
  assert.equal(Object.isFrozen(execution), true);
});

test('TranslationExecution accepts and preserves provider key attribution', () => {
  const execution = createPendingExecution({ providerKey: 'gemini' });

  assert.equal(execution.providerKey, 'gemini');
  assert.equal(execution.start(1100).providerKey, 'gemini');
  assert.equal(execution.start(1100).complete(1200).providerKey, 'gemini');
});

test('TranslationExecution rejects blank provider key attribution', () => {
  assert.throws(() => createPendingExecution({ providerKey: '' }), /providerKey/);
  assert.throws(() => createPendingExecution({ providerKey: '   ' }), /providerKey/);
});

test('TranslationExecution rejects non-string provider key attribution', () => {
  for (const providerKey of [null, 1, true, {}, []]) {
    assert.throws(() => createPendingExecution({ providerKey }), /providerKey must be a string/);
  }
});

test('TranslationExecution supports every allowed transition', () => {
  const pending = createPendingExecution();

  assert.equal(pending.start(1100).status, 'running');
  assert.equal(pending.fail({ reason: 'provider_error' }, 1200).status, 'failed');
  assert.equal(pending.cancel(1200).status, 'cancelled');

  const running = pending.start(1100);
  assert.equal(running.complete(1300).status, 'completed');
  assert.equal(running.fail({ reason: 'provider_error' }, 1300).status, 'failed');
  assert.equal(running.cancel(1300).status, 'cancelled');
});

test('TranslationExecution rejects representative illegal transitions', () => {
  const pending = createPendingExecution();
  const running = pending.start(1100);
  const completed = running.complete(1200);
  const failed = running.fail({ reason: 'provider_error' }, 1200);
  const cancelled = running.cancel(1200);

  assert.throws(() => pending.complete(1200), /transition/);
  assert.throws(() => running.start(1200), /transition/);
  assert.throws(() => completed.fail({ reason: 'later' }, 1300), /transition/);
  assert.throws(() => failed.cancel(1300), /transition/);
  assert.throws(() => cancelled.start(1300), /transition/);
});

test('TranslationExecution completed state requires completion timestamp', () => {
  assert.throws(
    () =>
      new TranslationExecution({
        id: 'execution-1',
        translationRequestId: 'request-1',
        status: 'completed',
        startedAt: 1000
      }),
    /completedAt/
  );
});

test('TranslationExecution failed state requires failure information', () => {
  assert.throws(
    () =>
      new TranslationExecution({
        id: 'execution-1',
        translationRequestId: 'request-1',
        status: 'failed',
        startedAt: 1000,
        completedAt: 1200
      }),
    /failureInfo/
  );
});

test('TranslationExecution non-failed state rejects failure information', () => {
  assert.throws(
    () =>
      new TranslationExecution({
        id: 'execution-1',
        translationRequestId: 'request-1',
        status: 'running',
        startedAt: 1000,
        failureInfo: { reason: 'provider_error' }
      }),
    /failureInfo/
  );
});

test('TranslationExecution transition returns new object and preserves original', () => {
  const pending = createPendingExecution();
  const running = pending.start(1100);

  assert.notEqual(running, pending);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.startedAt, 1000);
  assert.equal(pending.completedAt, null);
  assert.equal(running.status, 'running');
  assert.equal(running.startedAt, 1100);
});

test('TranslationExecution failure information is deeply immutable', () => {
  const failureInfo = {
    reason: 'provider_error',
    providerMetadata: { code: 'UNAVAILABLE', details: ['retry later'] }
  };
  const failed = createPendingExecution().start(1100).fail(failureInfo, 1200);

  failureInfo.reason = 'changed';
  failureInfo.providerMetadata.code = 'changed';
  failureInfo.providerMetadata.details.push('changed');

  assert.deepEqual(failed.failureInfo, {
    reason: 'provider_error',
    providerMetadata: { code: 'UNAVAILABLE', details: ['retry later'] }
  });
  assert.throws(() => {
    failed.failureInfo.providerMetadata.details.push('changed');
  }, TypeError);
  assert.deepEqual(failed.failureInfo.providerMetadata.details, ['retry later']);
});

test('TranslationOutput constructs a valid immutable output', () => {
  const output = new TranslationOutput({
    id: 'output-1',
    executionId: 'execution-1',
    sequence: 0,
    translatedText: 'こんにちは',
    targetLanguageCode: 'ja',
    createdAt: '2026-07-13T08:01:00.000Z'
  });

  assert.equal(output.id, 'output-1');
  assert.equal(output.executionId, 'execution-1');
  assert.equal(output.sequence, 0);
  assert.equal(output.translatedText, 'こんにちは');
  assert.equal(output.targetLanguageCode, 'ja');
  assert.equal(output.providerMetadata, null);
  assert.equal(output.providerMetadataAvailable, false);
  assert.equal(Object.isFrozen(output), true);
});

test('TranslationOutput rejects invalid sequence values', () => {
  assert.throws(() => createOutput({ sequence: -1 }), /sequence/);
  assert.throws(() => createOutput({ sequence: 1.5 }), /sequence/);
});

test('TranslationOutput rejects empty translated text', () => {
  assert.throws(() => createOutput({ translatedText: '' }), /translatedText/);
});

test('TranslationOutput rejects invalid target language code', () => {
  assert.throws(() => createOutput({ targetLanguageCode: '' }), /targetLanguageCode/);
});

test('TranslationOutput defensively copies provider metadata', () => {
  const metadata = {
    tokenUsage: { total: 12 },
    warnings: ['low-confidence']
  };
  const output = createOutput({ providerMetadata: metadata });

  metadata.tokenUsage.total = 99;
  metadata.warnings.push('changed');

  assert.equal(output.providerMetadataAvailable, true);
  assert.deepEqual(output.providerMetadata, {
    tokenUsage: { total: 12 },
    warnings: ['low-confidence']
  });
});

test('TranslationOutput provider metadata is deeply immutable', () => {
  const output = createOutput({
    providerMetadata: {
      tokenUsage: { total: 12 },
      warnings: ['low-confidence']
    }
  });

  assert.throws(() => {
    output.providerMetadata.tokenUsage.total = 99;
  }, TypeError);
  assert.throws(() => {
    output.providerMetadata.warnings.push('changed');
  }, TypeError);
  assert.deepEqual(output.providerMetadata, {
    tokenUsage: { total: 12 },
    warnings: ['low-confidence']
  });
});

function createPendingExecution(overrides = {}) {
  return new TranslationExecution({
    id: 'execution-1',
    translationRequestId: 'request-1',
    startedAt: 1000,
    ...overrides
  });
}

function createOutput(overrides = {}) {
  return new TranslationOutput({
    id: 'output-1',
    executionId: 'execution-1',
    sequence: 0,
    translatedText: 'translated text',
    targetLanguageCode: 'ja',
    createdAt: 1000,
    ...overrides
  });
}
