import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionEventBroadcaster } from '../../src/infrastructure/executionEventBroadcaster.js';

test('execution broadcaster scopes listeners and increments sequence per session', () => {
  const broadcaster = createExecutionEventBroadcaster();
  const first = [];
  const second = [];
  const unsubscribe = broadcaster.subscribe('session-1', (event) => first.push(event));
  broadcaster.subscribe('session-2', (event) => second.push(event));

  broadcaster.publish('session-1', {
    id: 'execution-1', requestId: 'request-1', translationRequestId: 'request-1',
    status: 'queued', failureInfo: { message: 'safe' }
  });
  broadcaster.publish('session-1', { id: 'execution-1', status: 'running' });
  broadcaster.publish('session-2', { id: 'execution-2', status: 'completed' });

  assert.deepEqual(first.map((event) => [event.sequence, event.sessionId]), [[1, 'session-1'], [2, 'session-1']]);
  assert.deepEqual(second.map((event) => [event.sequence, event.sessionId]), [[1, 'session-2']]);
  assert.equal(first[0].type, 'execution.snapshot');
  assert.equal(Object.hasOwn(first[0].execution, 'providerResult'), false);
  unsubscribe();
  broadcaster.publish('session-1', { id: 'execution-1', status: 'completed' });
  assert.equal(first.length, 2);
});
