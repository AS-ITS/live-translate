import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionQueue } from '../../src/application/translation/translationExecutionQueue.js';
import { createInMemoryTranslationExecutionQueue } from '../../src/infrastructure/inMemoryTranslationExecutionQueue.js';

const INVALID_EXECUTION_ID_ERROR = /Translation execution queue job executionId must be a non-empty string/;
const INVALID_REQUEST_ID_ERROR = /Translation execution queue job requestId must be a non-empty string/;

test('module exports createInMemoryTranslationExecutionQueue factory', async () => {
  const moduleExports = await import('../../src/infrastructure/inMemoryTranslationExecutionQueue.js');

  assert.deepEqual(Object.keys(moduleExports), ['createInMemoryTranslationExecutionQueue']);
  assert.equal(moduleExports.createInMemoryTranslationExecutionQueue, createInMemoryTranslationExecutionQueue);
});

test('factory returns queue object with enqueue dequeue and size only', () => {
  const queue = createInMemoryTranslationExecutionQueue();

  assert.equal(typeof queue, 'object');
  assert.notEqual(queue, null);
  assert.equal(Object.isFrozen(queue), true);
  assert.deepEqual(Object.keys(queue), ['enqueue', 'dequeue', 'size']);
  assert.equal(typeof queue.enqueue, 'function');
  assert.equal(typeof queue.dequeue, 'function');
  assert.equal(typeof queue.size, 'function');
});

test('application contract wraps a queue without depending on infrastructure', () => {
  const queue = createTranslationExecutionQueue({
    enqueue(job) {
      return job;
    },
    dequeue() {
      return undefined;
    }
  });

  assert.deepEqual(Object.keys(queue), ['enqueue', 'dequeue']);
  assert.equal(Object.isFrozen(queue), true);
});

test('enqueue then dequeue returns the same job', () => {
  const queue = createInMemoryTranslationExecutionQueue();
  const job = createJob();

  queue.enqueue(job);

  assert.strictEqual(queue.dequeue(), job);
});

test('multiple jobs dequeue in FIFO order', () => {
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

test('dequeue returns undefined when queue is empty', () => {
  const queue = createInMemoryTranslationExecutionQueue();

  assert.equal(queue.dequeue(), undefined);
});

test('dequeue removes the job from the queue', () => {
  const queue = createInMemoryTranslationExecutionQueue();
  const job = createJob();

  queue.enqueue(job);
  assert.strictEqual(queue.dequeue(), job);

  assert.equal(queue.dequeue(), undefined);
});

test('enqueue rejects missing executionId', () => {
  const queue = createInMemoryTranslationExecutionQueue();

  assert.throws(() => queue.enqueue({ requestId: 'request-1' }), INVALID_EXECUTION_ID_ERROR);
});

test('enqueue rejects missing requestId', () => {
  const queue = createInMemoryTranslationExecutionQueue();

  assert.throws(() => queue.enqueue({ executionId: 'execution-1' }), INVALID_REQUEST_ID_ERROR);
});

test('enqueue rejects empty string identifiers', () => {
  const queue = createInMemoryTranslationExecutionQueue();

  assert.throws(() => queue.enqueue({ executionId: '', requestId: 'request-1' }), INVALID_EXECUTION_ID_ERROR);
  assert.throws(() => queue.enqueue({ executionId: '   ', requestId: 'request-1' }), INVALID_EXECUTION_ID_ERROR);
  assert.throws(() => queue.enqueue({ executionId: 'execution-1', requestId: '' }), INVALID_REQUEST_ID_ERROR);
  assert.throws(() => queue.enqueue({ executionId: 'execution-1', requestId: '   ' }), INVALID_REQUEST_ID_ERROR);
});

test('enqueue does not mutate the input job', () => {
  const queue = createInMemoryTranslationExecutionQueue();
  const job = createJob({
    executionId: 'execution-1',
    requestId: 'request-1',
    metadata: Object.freeze({ source: 'test' })
  });
  const before = structuredClone(job);

  queue.enqueue(job);

  assert.deepEqual(job, before);
});

test('size reflects enqueue and dequeue operations', () => {
  const queue = createInMemoryTranslationExecutionQueue();
  const first = createJob({ executionId: 'execution-1', requestId: 'request-1' });
  const second = createJob({ executionId: 'execution-2', requestId: 'request-2' });

  assert.equal(queue.size(), 0);

  queue.enqueue(first);
  assert.equal(queue.size(), 1);

  queue.enqueue(second);
  assert.equal(queue.size(), 2);

  queue.dequeue();
  assert.equal(queue.size(), 1);

  queue.dequeue();
  assert.equal(queue.size(), 0);
});

test('enqueue does not execute provider or worker behavior', () => {
  const queue = createInMemoryTranslationExecutionQueue();
  const job = createJob();
  let providerExecuteCalls = 0;

  job.provider = Object.freeze({
    execute() {
      providerExecuteCalls += 1;
    }
  });

  queue.enqueue(job);

  assert.equal(providerExecuteCalls, 0);
  assert.strictEqual(queue.dequeue(), job);
});

function createJob(overrides = {}) {
  return {
    executionId: 'execution-1',
    requestId: 'request-1',
    ...overrides
  };
}
