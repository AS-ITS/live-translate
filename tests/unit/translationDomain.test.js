import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVIDER_ATTEMPT_STATUSES,
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
  assert.equal(execution.status, 'created');
  assert.equal(execution.providerKey, undefined);
  assert.equal(execution.providerIdempotencyKey, 'translation-execution:execution-1');
  assert.equal(execution.providerAttemptStatus, 'not_started');
  assert.equal(execution.providerAttemptedAt, null);
  assert.equal(execution.providerCompletedAt, null);
  assert.equal(execution.startedAt, 1000);
  assert.equal(execution.completedAt, null);
  assert.equal(execution.failureInfo, null);
  assert.deepEqual(TRANSLATION_EXECUTION_STATUSES, ['created', 'queued', 'running', 'completed', 'failed', 'cancelled']);
  assert.equal(Object.isFrozen(execution), true);
});

test('TranslationExecution records validated immutable provider attempt transitions', () => {
  const inFlight = createCreatedExecution().markProviderAttemptInFlight(1100);
  const succeeded = inFlight.markProviderAttemptSucceeded(1200, { translatedText: 'Bonjour' });
  const failed = createCreatedExecution().markProviderAttemptInFlight(1100).markProviderAttemptFailed(1200);

  assert.deepEqual(PROVIDER_ATTEMPT_STATUSES, ['not_started', 'in_flight', 'succeeded', 'failed']);
  assert.equal(inFlight.providerAttemptStatus, 'in_flight');
  assert.equal(inFlight.providerAttemptedAt, 1100);
  assert.equal(inFlight.providerCompletedAt, null);
  assert.equal(succeeded.providerAttemptStatus, 'succeeded');
  assert.equal(succeeded.providerCompletedAt, 1200);
  assert.equal(failed.providerAttemptStatus, 'failed');
  assert.equal(failed.providerIdempotencyKey, 'translation-execution:execution-1');
  assert.throws(
    () => createCreatedExecution().markProviderAttemptSucceeded(1200, { translatedText: 'Bonjour' }),
    /provider attempt transition/
  );
  assert.throws(
    () => createCreatedExecution({ providerAttemptStatus: 'in_flight', providerAttemptedAt: 1100, providerCompletedAt: 1200 }),
    /providerCompletedAt is not allowed/
  );
});

test('TranslationExecution generates a deterministic immutable provider idempotency key', () => {
  const first = createCreatedExecution({ id: 'execution-1' });
  const sameId = createCreatedExecution({ id: 'execution-1' });
  const otherId = createCreatedExecution({ id: 'execution-2' });

  assert.equal(first.providerIdempotencyKey, 'translation-execution:execution-1');
  assert.equal(sameId.providerIdempotencyKey, first.providerIdempotencyKey);
  assert.notEqual(otherId.providerIdempotencyKey, first.providerIdempotencyKey);
  assert.equal(first.queue().providerIdempotencyKey, first.providerIdempotencyKey);
  assert.equal(first.start(1100).providerIdempotencyKey, first.providerIdempotencyKey);
  assert.equal(first.queue().start(1100).complete(1200).providerIdempotencyKey, first.providerIdempotencyKey);
  assert.equal(first.queue().fail({ reason: 'provider_error' }, 1200).providerIdempotencyKey, first.providerIdempotencyKey);
});

test('TranslationExecution validates execution and provider idempotency keys deterministically', () => {
  assert.throws(() => createCreatedExecution({ id: '' }), /id/);
  assert.throws(() => createCreatedExecution({ providerIdempotencyKey: '' }), /providerIdempotencyKey/);
  assert.throws(() => createCreatedExecution({ providerIdempotencyKey: 1 }), /providerIdempotencyKey must be a string/);
  assert.throws(
    () => createCreatedExecution({ providerIdempotencyKey: 'translation-execution:other-execution' }),
    /providerIdempotencyKey must match execution id: execution-1/
  );
});

test('TranslationExecution accepts and preserves provider key attribution', () => {
  const execution = createCreatedExecution({ providerKey: 'gemini' });

  assert.equal(execution.providerKey, 'gemini');
  assert.equal(execution.queue().providerKey, 'gemini');
  assert.equal(execution.start(1100).providerKey, 'gemini');
  assert.equal(execution.queue().start(1100).complete(1200).providerKey, 'gemini');
});

test('TranslationExecution rejects blank provider key attribution', () => {
  assert.throws(() => createCreatedExecution({ providerKey: '' }), /providerKey/);
  assert.throws(() => createCreatedExecution({ providerKey: '   ' }), /providerKey/);
});

test('TranslationExecution rejects non-string provider key attribution', () => {
  for (const providerKey of [null, 1, true, {}, []]) {
    assert.throws(() => createCreatedExecution({ providerKey }), /providerKey must be a string/);
  }
});

test('TranslationExecution supports every allowed transition', () => {
  const created = createCreatedExecution();

  assert.equal(created.queue().status, 'queued');
  assert.equal(created.start(1100).status, 'running');
  assert.equal(created.fail({ reason: 'provider_error' }, 1200).status, 'failed');

  const queued = created.queue();
  assert.equal(queued.start(1200).status, 'running');
  assert.equal(queued.fail({ reason: 'provider_error' }, 1300).status, 'failed');
  assert.equal(queued.cancel(1300).status, 'cancelled');

  const running = queued.start(1100);
  assert.equal(running.resumeAfterExpiredLease().status, 'queued');
  assert.equal(running.complete(1300).status, 'completed');
  assert.equal(running.fail({ reason: 'provider_error' }, 1300).status, 'failed');
});

test('TranslationExecution rejects representative illegal transitions', () => {
  const created = createCreatedExecution();
  const queued = created.queue();
  const running = queued.start(1100);
  const completed = running.complete(1200);
  const failed = running.fail({ reason: 'provider_error' }, 1200);
  const cancelled = queued.cancel(1200);

  assert.throws(() => created.complete(1200), /transition/);
  assert.throws(() => queued.queue(), /transition/);
  assert.throws(() => queued.complete(1200), /transition/);
  assert.throws(() => running.start(1200), /transition/);
  assert.throws(() => running.transitionTo('created'), /transition/);
  assert.throws(() => completed.resumeAfterExpiredLease(), /transition/);
  assert.throws(() => completed.fail({ reason: 'later' }, 1300), /transition/);
  assert.throws(() => failed.start(1300), /transition/);
  assert.throws(() => cancelled.cancel(1300), /status transition from cancelled to cancelled is not allowed/);
  assert.throws(() => cancelled.start(1300), /status transition from cancelled to running is not allowed/);
});

test('TranslationExecution rejects unsupported legacy statuses', () => {
  assert.throws(() => createCreatedExecution({ status: 'pending' }), /status is not supported: pending/);
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
  const created = createCreatedExecution();
  const queued = created.queue();
  const running = queued.start(1100);

  assert.notEqual(queued, created);
  assert.notEqual(running, queued);
  assert.equal(created.status, 'created');
  assert.equal(created.startedAt, 1000);
  assert.equal(created.completedAt, null);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.startedAt, 1000);
  assert.equal(running.status, 'running');
  assert.equal(running.startedAt, 1100);
});

test('TranslationExecution failure information is deeply immutable', () => {
  const failureInfo = {
    reason: 'provider_error',
    providerMetadata: { code: 'UNAVAILABLE', details: ['retry later'] }
  };
  const failed = createCreatedExecution().queue().start(1100).fail(failureInfo, 1200);

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

function createCreatedExecution(overrides = {}) {
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
