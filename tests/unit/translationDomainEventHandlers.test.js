import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationDomainEventHandlers } from '../../src/application/translation/translationDomainEventHandlers.js';
import { createTranslationDomainEventHandlers as createTranslationDomainEventHandlersFromIndex } from '../../src/application/translation/index.js';

const HANDLER_NAMES = Object.freeze([
  'requestCreated',
  'executionCreated',
  'executionUpdated',
  'outputCreated'
]);

test('factory export exists and is callable from module and index', () => {
  assert.equal(typeof createTranslationDomainEventHandlers, 'function');
  assert.strictEqual(createTranslationDomainEventHandlersFromIndex, createTranslationDomainEventHandlers);
});

test('factory returns a frozen handlers object with the exact handler shape', () => {
  const handlers = createTranslationDomainEventHandlers();

  assert.equal(typeof handlers, 'object');
  assert.notEqual(handlers, null);
  assert.equal(Object.isFrozen(handlers), true);
  assert.deepEqual(Object.keys(handlers), HANDLER_NAMES);

  for (const handlerName of HANDLER_NAMES) {
    assert.equal(typeof handlers[handlerName], 'function');
  }
});

for (const handlerName of HANDLER_NAMES) {
  test(`${handlerName} returns a promise that resolves undefined`, async () => {
    const handlers = createTranslationDomainEventHandlers();
    const result = handlers[handlerName](createEvent());

    assert.equal(typeof result, 'object');
    assert.notEqual(result, null);
    assert.equal(typeof result.then, 'function');
    await assert.doesNotReject(result);
    assert.equal(await result, undefined);
  });

  test(`${handlerName} preserves event and payload input`, async () => {
    const handlers = createTranslationDomainEventHandlers();
    const event = createEvent();
    const originalPayload = event.payload;
    const originalRequest = event.payload.request;
    const before = structuredClone(event);
    const beforeKeys = Object.keys(event);
    const beforePayloadKeys = Object.keys(event.payload);

    await handlers[handlerName](event);

    assert.deepEqual(event, before);
    assert.deepEqual(Object.keys(event), beforeKeys);
    assert.deepEqual(Object.keys(event.payload), beforePayloadKeys);
    assert.strictEqual(event.payload, originalPayload);
    assert.strictEqual(event.payload.request, originalRequest);
  });

  test(`${handlerName} safely resolves for absent or minimal input`, async () => {
    const handlers = createTranslationDomainEventHandlers();

    await assert.doesNotReject(handlers[handlerName](undefined));
    await assert.doesNotReject(handlers[handlerName](null));
    await assert.doesNotReject(handlers[handlerName]({}));
  });
}

test('factory invocations return isolated handler objects', () => {
  const firstHandlers = createTranslationDomainEventHandlers();
  const secondHandlers = createTranslationDomainEventHandlers();

  assert.notStrictEqual(firstHandlers, secondHandlers);
  assert.equal(firstHandlers.requestCreated, secondHandlers.requestCreated);
  assert.throws(() => {
    firstHandlers.extra = () => {};
  }, TypeError);
  assert.deepEqual(Object.keys(firstHandlers), HANDLER_NAMES);
  assert.deepEqual(Object.keys(secondHandlers), HANDLER_NAMES);
});

function createEvent() {
  return {
    type: 'translation.request.created',
    occurredAt: '2026-07-14T01:00:00.000Z',
    payload: {
      request: {
        id: 'request-1',
        targetLanguageCode: 'zh-Hant'
      }
    }
  };
}
