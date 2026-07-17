import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertTranslationExecutionQueue,
  createTranslationExecutionQueue
} from '../../src/application/translation/translationExecutionQueue.js';
import { createInMemoryTranslationExecutionQueue } from '../../src/infrastructure/inMemoryTranslationExecutionQueue.js';

const INVALID_EXECUTION_ID_ERROR = /Translation execution queue job executionId must be a non-empty string/;
const INVALID_REQUEST_ID_ERROR = /Translation execution queue job requestId must be a non-empty string/;

test('application contract exposes enqueue dequeue isEmpty and size only', () => {
  const queue = createTranslationExecutionQueue(queueImplementation());

  assert.deepEqual(Object.keys(queue), ['enqueue', 'dequeue', 'isEmpty', 'size']);
  assert.equal(Object.isFrozen(queue), true);
});

test('application contract requires enqueue dequeue isEmpty and size methods', () => {
  assert.throws(() => assertTranslationExecutionQueue(undefined), /translationExecutionQueue implementation is required/);
  assert.throws(
    () => createTranslationExecutionQueue({ dequeue() {}, isEmpty() {}, size() {} }),
    /translationExecutionQueue.enqueue must be a function/
  );
  assert.throws(
    () => createTranslationExecutionQueue({ enqueue() {}, isEmpty() {}, size() {} }),
    /translationExecutionQueue.dequeue must be a function/
  );
  assert.throws(
    () => createTranslationExecutionQueue({ enqueue() {}, dequeue() {}, size() {} }),
    /translationExecutionQueue.isEmpty must be a function/
  );
  assert.throws(
    () => createTranslationExecutionQueue({ enqueue() {}, dequeue() {}, isEmpty() {} }),
    /translationExecutionQueue.size must be a function/
  );
});

test('in-memory queue implements the application contract', () => {
  const queue = createInMemoryTranslationExecutionQueue();

  assert.doesNotThrow(() => assertTranslationExecutionQueue(queue));
  assert.deepEqual(Object.keys(queue), ['enqueue', 'dequeue', 'isEmpty', 'size']);
  assert.equal(Object.isFrozen(queue), true);
});

test('in-memory queue enqueues and dequeues in FIFO order', () => {
  const queue = createInMemoryTranslationExecutionQueue();
  const first = createJob({ executionId: 'execution-1', requestId: 'request-1' });
  const second = createJob({ executionId: 'execution-2', requestId: 'request-2' });
  const third = createJob({ executionId: 'execution-3', requestId: 'request-3' });

  queue.enqueue(first);
  queue.enqueue(second);
  queue.enqueue(third);

  assert.strictEqual(queue.dequeue(), first);
  assert.strictEqual(queue.dequeue(), second);
  assert.strictEqual(queue.dequeue(), third);
});

test('empty in-memory queue dequeue returns undefined', () => {
  const queue = createInMemoryTranslationExecutionQueue();

  assert.equal(queue.dequeue(), undefined);
});

test('in-memory queue isEmpty and size reflect queue state', () => {
  const queue = createInMemoryTranslationExecutionQueue();
  const first = createJob({ executionId: 'execution-1', requestId: 'request-1' });
  const second = createJob({ executionId: 'execution-2', requestId: 'request-2' });

  assert.equal(queue.isEmpty(), true);
  assert.equal(queue.size(), 0);

  queue.enqueue(first);
  assert.equal(queue.isEmpty(), false);
  assert.equal(queue.size(), 1);

  queue.enqueue(second);
  assert.equal(queue.isEmpty(), false);
  assert.equal(queue.size(), 2);

  queue.dequeue();
  assert.equal(queue.isEmpty(), false);
  assert.equal(queue.size(), 1);

  queue.dequeue();
  assert.equal(queue.isEmpty(), true);
  assert.equal(queue.size(), 0);
});

test('enqueue rejects missing or empty job identifiers', () => {
  const queue = createInMemoryTranslationExecutionQueue();

  assert.throws(() => queue.enqueue({ requestId: 'request-1' }), INVALID_EXECUTION_ID_ERROR);
  assert.throws(() => queue.enqueue({ executionId: 'execution-1' }), INVALID_REQUEST_ID_ERROR);
  assert.throws(() => queue.enqueue({ executionId: '', requestId: 'request-1' }), INVALID_EXECUTION_ID_ERROR);
  assert.throws(() => queue.enqueue({ executionId: 'execution-1', requestId: '   ' }), INVALID_REQUEST_ID_ERROR);
});

function queueImplementation() {
  const jobs = [];

  return {
    enqueue(job) {
      jobs.push(job);
    },
    dequeue() {
      return jobs.shift();
    },
    isEmpty() {
      return jobs.length === 0;
    },
    size() {
      return jobs.length;
    }
  };
}

function createJob(overrides = {}) {
  return {
    executionId: 'execution-1',
    requestId: 'request-1',
    ...overrides
  };
}
