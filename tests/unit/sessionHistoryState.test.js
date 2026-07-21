import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPendingExecutions, replaceHistoryExecution, selectedOutputFor } from '../../src/lib/sessionHistoryState.js';

test('recognizes pending execution and preserves an existing selection', () => {
  const history = { translationHistory: { outputs: [{ id: 'v2' }, { id: 'v1' }], executions: [{ id: 'e', status: 'queued' }] } };
  assert.equal(hasPendingExecutions(history), true);
  assert.equal(selectedOutputFor(history, 'v1').id, 'v1');
  assert.equal(selectedOutputFor(history, 'missing').id, 'v2');
});

test('treats queued and running executions as pending but cancelled execution as terminal', () => {
  assert.equal(hasPendingExecutions({ translationHistory: { executions: [{ status: 'running' }] } }), true);
  assert.equal(hasPendingExecutions({ translationHistory: { executions: [{ status: 'cancelled' }] } }), false);
});

test('replaces a controlled execution without changing selected outputs or unrelated executions', () => {
  const history = {
    translationHistory: {
      outputs: [{ id: 'output-1' }],
      executions: [
        { id: 'execution-1', requestId: 'request-1', targetLanguageCode: 'ja', status: 'queued' },
        { id: 'execution-2', requestId: 'request-2', targetLanguageCode: 'fr', status: 'failed' }
      ]
    }
  };

  const next = replaceHistoryExecution(history, { id: 'execution-1', translationRequestId: 'request-1', status: 'cancelled' });

  assert.deepEqual(next.translationHistory.outputs, history.translationHistory.outputs);
  assert.deepEqual(next.translationHistory.executions, [
    { id: 'execution-1', requestId: 'request-1', targetLanguageCode: 'ja', translationRequestId: 'request-1', status: 'cancelled' },
    history.translationHistory.executions[1]
  ]);
});
