import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionDispatcher } from '../../src/application/translation/translationExecutionDispatcher.js';

test('async dispatch implementation is accepted', async () => {
  const dispatcher = createTranslationExecutionDispatcher({
    async dispatch({ execution, provider }) {
      return { execution, provider };
    }
  });
  const execution = Object.freeze({ id: 'execution-1' });
  const provider = Object.freeze({ key: 'fake' });

  assert.equal(typeof dispatcher, 'object');
  assert.notEqual(dispatcher, null);
  assert.deepEqual(Object.keys(dispatcher), ['dispatch']);
  assert.equal(typeof dispatcher.dispatch, 'function');
  assert.equal(dispatcher.dispatch.length, 1);

  await assert.doesNotReject(() => dispatcher.dispatch({ execution, provider }));
  assert.deepEqual(await dispatcher.dispatch({ execution, provider }), { execution, provider });
});

test('missing dispatch throws', () => {
  assert.throws(
    () => createTranslationExecutionDispatcher({}),
    /translationExecutionDispatcher\.dispatch must be a function/
  );
});

test('dispatch that is not a function throws', () => {
  assert.throws(
    () => createTranslationExecutionDispatcher({ dispatch: 'not-a-function' }),
    /translationExecutionDispatcher\.dispatch must be a function/
  );
});

test('contract performs no execution logic', async () => {
  let providerExecuteCalls = 0;
  let implementationDispatchCalls = 0;
  const execution = Object.freeze({ id: 'execution-1' });
  const provider = Object.freeze({
    key: 'fake',
    execute() {
      providerExecuteCalls += 1;
      throw new Error('Provider execution should not be invoked by the dispatcher contract.');
    }
  });
  const dispatcher = createTranslationExecutionDispatcher({
    async dispatch(input) {
      implementationDispatchCalls += 1;
      return input;
    }
  });

  const result = await dispatcher.dispatch({ execution, provider });

  assert.equal(implementationDispatchCalls, 1);
  assert.equal(providerExecuteCalls, 0);
  assert.deepEqual(result, { execution, provider });
});
