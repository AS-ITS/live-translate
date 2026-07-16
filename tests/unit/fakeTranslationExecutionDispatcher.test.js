import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionDispatcher } from '../../src/application/translation/translationExecutionDispatcher.js';
import { createFakeTranslationExecutionDispatcher } from '../../src/infrastructure/fakeTranslationExecutionDispatcher.js';

test('construction starts with an empty dispatched execution list', () => {
  const dispatcher = createFakeTranslationExecutionDispatcher();

  assert.equal(Object.isFrozen(dispatcher), true);
  assert.equal(typeof dispatcher.dispatch, 'function');
  assert.deepEqual(dispatcher.dispatchedExecutions, []);
});

test('fake dispatcher satisfies the TranslationExecutionDispatcher contract', async () => {
  const fakeDispatcher = createFakeTranslationExecutionDispatcher();
  const dispatcher = createTranslationExecutionDispatcher(fakeDispatcher);
  const execution = translationExecution();
  const provider = providerSpy();

  await dispatcher.dispatch({ execution, provider });

  assert.deepEqual(fakeDispatcher.dispatchedExecutions, [{ execution, provider }]);
});

test('dispatch returns a Promise and records the execution reference', async () => {
  const dispatcher = createFakeTranslationExecutionDispatcher();
  const execution = translationExecution();

  const resultPromise = dispatcher.dispatch(execution);

  assert.equal(typeof resultPromise.then, 'function');
  assert.deepEqual(await resultPromise, { status: 'dispatched' });
  assert.strictEqual(dispatcher.dispatchedExecutions[0], execution);
});

test('dispatch appends executions in order and supports multiple dispatches', async () => {
  const dispatcher = createFakeTranslationExecutionDispatcher();
  const firstExecution = translationExecution({ id: 'execution-1' });
  const secondExecution = translationExecution({ id: 'execution-2' });
  const thirdExecution = translationExecution({ id: 'execution-3' });

  await dispatcher.dispatch(firstExecution);
  await dispatcher.dispatch(secondExecution);
  await dispatcher.dispatch(thirdExecution);

  assert.deepEqual(dispatcher.dispatchedExecutions, [firstExecution, secondExecution, thirdExecution]);
});

test('dispatch does not mutate execution', async () => {
  const dispatcher = createFakeTranslationExecutionDispatcher();
  const execution = translationExecution({
    metadata: {
      nested: {
        preserved: true
      }
    }
  });
  const before = structuredClone(execution);

  await dispatcher.dispatch(execution);

  assert.deepEqual(execution, before);
});

test('dispatch does not resolve provider, create outputs, persist, or publish events', async () => {
  const dispatcher = createFakeTranslationExecutionDispatcher();
  const execution = translationExecution();
  let providerResolveCalls = 0;
  let outputCreateCalls = 0;
  let persistenceCalls = 0;
  let publishCalls = 0;
  const sideEffects = Object.freeze({
    resolveProvider() {
      providerResolveCalls += 1;
    },
    createOutput() {
      outputCreateCalls += 1;
    },
    persist() {
      persistenceCalls += 1;
    },
    publish() {
      publishCalls += 1;
    }
  });

  await dispatcher.dispatch(execution);

  assert.equal(providerResolveCalls, 0);
  assert.equal(outputCreateCalls, 0);
  assert.equal(persistenceCalls, 0);
  assert.equal(publishCalls, 0);
  assert.equal(Object.hasOwn(dispatcher, 'providerResolver'), false);
  assert.equal(Object.hasOwn(dispatcher, 'translationRepository'), false);
  assert.equal(Object.hasOwn(dispatcher, 'domainEventPublisher'), false);
  assert.equal(Object.hasOwn(dispatcher, 'queue'), false);
  assert.equal(Object.hasOwn(dispatcher, 'scheduler'), false);
  assert.deepEqual(Object.keys(sideEffects), ['resolveProvider', 'createOutput', 'persist', 'publish']);
});

test('repeated dispatch of the same execution behaves deterministically', async () => {
  const dispatcher = createFakeTranslationExecutionDispatcher();
  const execution = translationExecution();

  const firstResult = await dispatcher.dispatch(execution);
  const secondResult = await dispatcher.dispatch(execution);

  assert.deepEqual(firstResult, { status: 'dispatched' });
  assert.deepEqual(secondResult, { status: 'dispatched' });
  assert.deepEqual(dispatcher.dispatchedExecutions, [execution, execution]);
  assert.strictEqual(dispatcher.dispatchedExecutions[0], dispatcher.dispatchedExecutions[1]);
});

test('inspection returns a defensive snapshot of dispatched executions', async () => {
  const dispatcher = createFakeTranslationExecutionDispatcher();
  const execution = translationExecution();

  await dispatcher.dispatch(execution);
  const dispatchedExecutions = dispatcher.dispatchedExecutions;
  dispatchedExecutions.push(translationExecution({ id: 'external' }));

  assert.deepEqual(dispatcher.dispatchedExecutions, [execution]);
  assert.notStrictEqual(dispatcher.dispatchedExecutions, dispatcher.dispatchedExecutions);
});

function translationExecution(overrides = {}) {
  return Object.freeze({
    id: 'execution-1',
    requestId: 'request-1',
    status: 'created',
    ...overrides
  });
}

function providerSpy() {
  return Object.freeze({
    key: 'fake',
    translate() {
      throw new Error('Provider translation should not be invoked by the fake dispatcher.');
    }
  });
}
