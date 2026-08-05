import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPendingRetranslationItems, retranslationProgressFor } from '../../src/lib/retranslationProgress.js';

test('completed output hides a queued execution with the same request id', () => {
  const progress = retranslationProgressFor({
    outputs: [output({ requestId: 'request-1', executionId: 'execution-1' })],
    executions: [execution({ id: 'execution-stale', requestId: 'request-1', status: 'queued' })]
  });

  assert.deepEqual(progress.outputs.map((item) => item.id), ['output-1']);
  assert.deepEqual(progress.executions, []);
  assert.equal(hasPendingRetranslationItems(progress), false);
});

test('completed output hides a running execution with the same execution id', () => {
  const progress = retranslationProgressFor({
    outputs: [output({ requestId: 'request-output', executionId: 'execution-1' })],
    executions: [execution({ id: 'execution-1', requestId: 'request-stale', status: 'running' })]
  });

  assert.deepEqual(progress.outputs.map((item) => item.id), ['output-1']);
  assert.deepEqual(progress.executions, []);
});

test('completed output hides an execution identified by executionId', () => {
  const progress = retranslationProgressFor({
    outputs: [{
      executionId: 'execution-1',
      outputText: 'Translated result',
      source: 'formal'
    }],
    executions: [{
      executionId: 'execution-1',
      status: 'running'
    }]
  });

  assert.equal(progress.executions.length, 0);
  assert.equal(hasPendingRetranslationItems(progress), false);
});

test('completed output hides matching optimistic tracked retranslation', () => {
  const progress = retranslationProgressFor(
    { outputs: [output({ requestId: 'request-1', executionId: 'execution-1' })], executions: [] },
    [{ requestId: 'request-1', executionId: 'execution-1', targetLanguageCode: 'fr' }]
  );

  assert.deepEqual(progress.outputs.map((item) => item.id), ['output-1']);
  assert.deepEqual(progress.executions, []);
});

test('unmatched queued and failed executions remain visible with pending based on active status only', () => {
  const progress = retranslationProgressFor({
    outputs: [],
    executions: [
      execution({ id: 'execution-queued', requestId: 'request-queued', status: 'queued' }),
      execution({ id: 'execution-failed', requestId: 'request-failed', status: 'failed' })
    ]
  });

  assert.deepEqual(progress.executions.map((item) => item.id), ['execution-queued', 'execution-failed']);
  assert.equal(hasPendingRetranslationItems(progress), true);
});

test('failed execution without output remains non-pending and retryable', () => {
  const progress = retranslationProgressFor({
    outputs: [],
    executions: [execution({ id: 'execution-failed', requestId: 'request-failed', status: 'failed' })]
  });

  assert.deepEqual(progress.executions.map((item) => item.id), ['execution-failed']);
  assert.equal(hasPendingRetranslationItems(progress), false);
});

function output(overrides = {}) {
  return {
    id: 'output-1',
    requestId: 'request-1',
    executionId: 'execution-1',
    targetLanguageCode: 'fr',
    translatedText: 'Bonjour',
    source: 'formal',
    ...overrides
  };
}

function execution(overrides = {}) {
  return {
    id: 'execution-1',
    requestId: 'request-1',
    targetLanguageCode: 'fr',
    status: 'queued',
    ...overrides
  };
}
