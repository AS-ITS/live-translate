import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPendingExecutions, selectedOutputFor } from '../../src/lib/sessionHistoryState.js';

test('recognizes pending execution and preserves an existing selection', () => {
  const history = { translationHistory: { outputs: [{ id: 'v2' }, { id: 'v1' }], executions: [{ id: 'e', status: 'queued' }] } };
  assert.equal(hasPendingExecutions(history), true);
  assert.equal(selectedOutputFor(history, 'v1').id, 'v1');
  assert.equal(selectedOutputFor(history, 'missing').id, 'v2');
});
