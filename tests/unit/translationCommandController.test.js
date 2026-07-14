import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationCommandController } from '../../server/translationCommandController.js';

const CONTROLLER_METHODS = Object.freeze([
  'createTranslationRequest',
  'createTranslationExecution',
  'updateTranslationExecution',
  'createTranslationOutput'
]);

test('factory throws TypeError when translationCommandService is missing', () => {
  assert.throws(() => createTranslationCommandController(), TypeError);
});

test('factory throws TypeError when any required service method is missing', () => {
  for (const missingMethod of CONTROLLER_METHODS) {
    const service = translationCommandService();
    delete service[missingMethod];

    assert.throws(
      () => createTranslationCommandController({ translationCommandService: service }),
      new RegExp(`translationCommandService\\.${missingMethod}`)
    );
  }
});

test('controller is frozen and exposes exactly the public command methods', () => {
  const controller = createTranslationCommandController({
    translationCommandService: translationCommandService()
  });

  assert.equal(Object.isFrozen(controller), true);
  assert.deepEqual(Object.keys(controller), CONTROLLER_METHODS);

  for (const method of CONTROLLER_METHODS) {
    assert.equal(typeof controller[method], 'function');
  }

  assert.throws(() => {
    controller.extraMethod = () => null;
  }, TypeError);
});

test('createTranslationRequest delegates once with unchanged argument and return value', () => {
  assertDelegatesOnce('createTranslationRequest');
});

test('createTranslationExecution delegates once with unchanged argument and return value', () => {
  assertDelegatesOnce('createTranslationExecution');
});

test('updateTranslationExecution delegates once with unchanged argument and return value', () => {
  assertDelegatesOnce('updateTranslationExecution');
});

test('createTranslationOutput delegates once with unchanged argument and return value', () => {
  assertDelegatesOnce('createTranslationOutput');
});

test('controller preserves synchronous service result path', () => {
  const serviceResult = { id: 'sync-result' };
  const controller = createTranslationCommandController({
    translationCommandService: translationCommandService({
      createTranslationRequest() {
        return serviceResult;
      }
    })
  });

  assert.strictEqual(controller.createTranslationRequest({ id: 'request-1' }), serviceResult);
});

test('controller preserves Promise service result path', async () => {
  const serviceResult = Promise.resolve({ id: 'async-result' });
  const controller = createTranslationCommandController({
    translationCommandService: translationCommandService({
      createTranslationExecution() {
        return serviceResult;
      }
    })
  });

  const result = controller.createTranslationExecution({ id: 'execution-1' });

  assert.strictEqual(result, serviceResult);
  assert.deepEqual(await result, { id: 'async-result' });
});

test('controller adds no DTO mapping, status conversion, logging, or side effects', () => {
  const calls = [];
  const unusualInput = { nested: { value: 'keep identity' }, status: 418 };
  const unusualResult = { unexpectedShape: true, status: 'not converted' };
  const service = translationCommandService({
    updateTranslationExecution(input) {
      calls.push(['updateTranslationExecution', input]);
      return unusualResult;
    }
  });
  const controller = createTranslationCommandController({
    translationCommandService: service
  });

  assert.strictEqual(controller.updateTranslationExecution(unusualInput), unusualResult);
  assert.deepEqual(calls, [['updateTranslationExecution', unusualInput]]);
});

function assertDelegatesOnce(methodName) {
  const calls = [];
  const input = { id: `${methodName}-input`, nested: { untouched: true } };
  const serviceResult = { id: `${methodName}-result` };
  const controller = createTranslationCommandController({
    translationCommandService: translationCommandService({
      [methodName](nextInput) {
        calls.push([methodName, nextInput]);
        return serviceResult;
      }
    })
  });

  const result = controller[methodName](input);

  assert.strictEqual(result, serviceResult);
  assert.deepEqual(calls, [[methodName, input]]);
  assert.strictEqual(calls[0][1], input);
}

function translationCommandService(overrides = {}) {
  return {
    createTranslationRequest:
      overrides.createTranslationRequest ||
      function createTranslationRequest(input) {
        return input;
      },
    createTranslationExecution:
      overrides.createTranslationExecution ||
      function createTranslationExecution(input) {
        return input;
      },
    updateTranslationExecution:
      overrides.updateTranslationExecution ||
      function updateTranslationExecution(input) {
        return input;
      },
    createTranslationOutput:
      overrides.createTranslationOutput ||
      function createTranslationOutput(input) {
        return input;
      }
  };
}
