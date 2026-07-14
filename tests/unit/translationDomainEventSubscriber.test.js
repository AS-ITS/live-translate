import assert from 'node:assert/strict';
import test from 'node:test';
import { TRANSLATION_EVENT_TYPES } from '../../src/domain/translation/index.js';
import { createInMemoryDomainEventBus } from '../../src/infrastructure/inMemoryDomainEventBus.js';
import { createTranslationDomainEventSubscriber } from '../../src/infrastructure/translationDomainEventSubscriber.js';

const EVENT_MAPPINGS = Object.freeze([
  Object.freeze({
    eventType: TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED,
    handlerName: 'requestCreated',
    createEvent: createRequestCreatedEvent
  }),
  Object.freeze({
    eventType: TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_CREATED,
    handlerName: 'executionCreated',
    createEvent: createExecutionCreatedEvent
  }),
  Object.freeze({
    eventType: TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_UPDATED,
    handlerName: 'executionUpdated',
    createEvent: createExecutionUpdatedEvent
  }),
  Object.freeze({
    eventType: TRANSLATION_EVENT_TYPES.TRANSLATION_OUTPUT_CREATED,
    handlerName: 'outputCreated',
    createEvent: createOutputCreatedEvent
  })
]);

test('factory returns a frozen subscriber object and construction does not subscribe', () => {
  const eventBus = eventBusSpy();
  const subscriber = createTranslationDomainEventSubscriber({
    eventBus,
    handlers: handlersSpy()
  });

  assert.equal(typeof subscriber, 'object');
  assert.notEqual(subscriber, null);
  assert.equal(Object.isFrozen(subscriber), true);
  assert.deepEqual(Object.keys(subscriber), ['subscribe']);
  assert.equal(typeof subscriber.subscribe, 'function');
  assert.equal(Object.hasOwn(subscriber, 'publish'), false);
  assert.equal(Object.hasOwn(subscriber, 'handlers'), false);
  assert.equal(eventBus.subscriptions.length, 0);
});

test('factory validates eventBus dependency immediately', () => {
  assert.throws(() => createTranslationDomainEventSubscriber(), /eventBus is required/);
  assert.throws(() => createTranslationDomainEventSubscriber({}), /eventBus is required/);
  assert.throws(
    () => createTranslationDomainEventSubscriber({ eventBus: null }),
    /eventBus is required/
  );
  assert.throws(
    () => createTranslationDomainEventSubscriber({ eventBus: 'invalid' }),
    /eventBus is required/
  );
  assert.throws(
    () => createTranslationDomainEventSubscriber({ eventBus: {} }),
    /eventBus\.subscribe must be a function/
  );
  assert.throws(
    () => createTranslationDomainEventSubscriber({ eventBus: { subscribe: true } }),
    /eventBus\.subscribe must be a function/
  );
});

test('factory validates provided handlers immediately', () => {
  for (const { handlerName } of EVENT_MAPPINGS) {
    for (const invalidValue of [null, {}, 'handler']) {
      assert.throws(
        () =>
          createTranslationDomainEventSubscriber({
            eventBus: eventBusSpy(),
            handlers: { [handlerName]: invalidValue }
          }),
        new RegExp(`handlers\\.${handlerName} must be a function`)
      );
    }
  }
});

test('factory accepts missing handlers and an empty handlers object', () => {
  assert.doesNotThrow(() => createTranslationDomainEventSubscriber({ eventBus: eventBusSpy() }));
  assert.doesNotThrow(() =>
    createTranslationDomainEventSubscriber({
      eventBus: eventBusSpy(),
      handlers: {}
    })
  );
});

test('subscribe registers exact translation event mappings', () => {
  const eventBus = eventBusSpy();
  const handlers = handlersSpy();
  const subscriber = createTranslationDomainEventSubscriber({ eventBus, handlers });

  const unsubscribe = subscriber.subscribe();

  assert.equal(typeof unsubscribe, 'function');
  assert.deepEqual(
    eventBus.subscriptions.map(({ eventType }) => eventType),
    EVENT_MAPPINGS.map(({ eventType }) => eventType)
  );

  for (const { eventType, handlerName, createEvent } of EVENT_MAPPINGS) {
    const subscription = eventBus.subscriptions.find((entry) => entry.eventType === eventType);
    const event = createEvent();
    subscription.handler(event);

    assert.deepEqual(handlers.calls.map(([name]) => name), [handlerName]);
    assert.strictEqual(handlers.calls[0][1], event);
    handlers.calls.length = 0;
  }
});

for (const { eventType, handlerName, createEvent } of EVENT_MAPPINGS) {
  test(`${eventType} dispatches only to ${handlerName} with exactly one argument`, () => {
    const eventBus = eventBusSpy();
    const handlers = handlersSpy();
    const subscriber = createTranslationDomainEventSubscriber({ eventBus, handlers });
    subscriber.subscribe();
    const event = createEvent();

    eventBus.subscriptionFor(eventType).handler(event);

    assert.equal(handlers.calls.length, 1);
    assert.equal(handlers.calls[0][0], handlerName);
    assert.equal(handlers.calls[0].length, 2);
    assert.strictEqual(handlers.calls[0][1], event);
  });
}

test('handler receives the same event, payload, and aggregate references', () => {
  const eventBus = eventBusSpy();
  let receivedEvent;
  const subscriber = createTranslationDomainEventSubscriber({
    eventBus,
    handlers: {
      requestCreated(event) {
        receivedEvent = event;
      }
    }
  });
  subscriber.subscribe();
  const event = createRequestCreatedEvent();

  eventBus.subscriptionFor(TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED).handler(event);

  assert.strictEqual(receivedEvent, event);
  assert.strictEqual(receivedEvent.payload, event.payload);
  assert.strictEqual(receivedEvent.payload.request, event.payload.request);
});

test('subscriber does not mutate event or payload', () => {
  const eventBus = eventBusSpy();
  const subscriber = createTranslationDomainEventSubscriber({
    eventBus,
    handlers: {
      requestCreated() {}
    }
  });
  subscriber.subscribe();
  const event = createRequestCreatedEvent();
  const originalPayload = event.payload;
  const originalAggregate = event.payload.request;
  const before = structuredClone(event);
  const beforeKeys = Object.keys(event);
  const beforePayloadKeys = Object.keys(event.payload);

  eventBus.subscriptionFor(TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED).handler(event);

  assert.deepEqual(event, before);
  assert.deepEqual(Object.keys(event), beforeKeys);
  assert.deepEqual(Object.keys(event.payload), beforePayloadKeys);
  assert.equal(event.type, TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED);
  assert.equal(event.occurredAt, 123);
  assert.strictEqual(event.payload, originalPayload);
  assert.strictEqual(event.payload.request, originalAggregate);
});

test('missing handlers safely no-op without invoking provided handlers', async () => {
  const partialCalls = [];
  const partialBus = createInMemoryDomainEventBus();
  const partialSubscriber = createTranslationDomainEventSubscriber({
    eventBus: partialBus,
    handlers: {
      requestCreated(event) {
        partialCalls.push(event);
      }
    }
  });
  partialSubscriber.subscribe();

  await partialBus.publish(createExecutionCreatedEvent());
  await partialBus.publish(createExecutionUpdatedEvent());
  await partialBus.publish(createOutputCreatedEvent());

  assert.deepEqual(partialCalls, []);

  const emptyBus = createInMemoryDomainEventBus();
  createTranslationDomainEventSubscriber({ eventBus: emptyBus, handlers: {} }).subscribe();

  await assert.doesNotReject(emptyBus.publish(createRequestCreatedEvent()));
  await assert.doesNotReject(emptyBus.publish(createExecutionCreatedEvent()));
  await assert.doesNotReject(emptyBus.publish(createExecutionUpdatedEvent()));
  await assert.doesNotReject(emptyBus.publish(createOutputCreatedEvent()));
});

test('subscriber callback returns handler return value by reference', () => {
  const eventBus = eventBusSpy();
  const promiseResult = Promise.resolve('handled');
  const syncResult = { handled: true };
  const subscriber = createTranslationDomainEventSubscriber({
    eventBus,
    handlers: {
      requestCreated() {
        return promiseResult;
      },
      executionCreated() {
        return syncResult;
      }
    }
  });
  subscriber.subscribe();

  assert.strictEqual(
    eventBus.subscriptionFor(TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED).handler(createRequestCreatedEvent()),
    promiseResult
  );
  assert.strictEqual(
    eventBus.subscriptionFor(TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_CREATED).handler(createExecutionCreatedEvent()),
    syncResult
  );
});

test('subscriber callback propagates sync handler errors unchanged', () => {
  const eventBus = eventBusSpy();
  const expectedError = new Error('handler failed');
  const subscriber = createTranslationDomainEventSubscriber({
    eventBus,
    handlers: {
      requestCreated() {
        throw expectedError;
      }
    }
  });
  subscriber.subscribe();

  assert.throws(
    () => eventBus.subscriptionFor(TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED).handler(createRequestCreatedEvent()),
    (actualError) => actualError === expectedError
  );
});

test('subscriber callback preserves rejected promise reference and error', async () => {
  const eventBus = eventBusSpy();
  const expectedError = new Error('async handler failed');
  const rejectedPromise = Promise.reject(expectedError);
  const subscriber = createTranslationDomainEventSubscriber({
    eventBus,
    handlers: {
      requestCreated() {
        return rejectedPromise;
      }
    }
  });
  subscriber.subscribe();

  const actual = eventBus.subscriptionFor(TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED).handler(
    createRequestCreatedEvent()
  );

  assert.strictEqual(actual, rejectedPromise);
  await assert.rejects(actual, (actualError) => actualError === expectedError);
});

test('unsubscribe returned by subscribe calls all underlying unsubscribers once', () => {
  const eventBus = eventBusSpy();
  const subscriber = createTranslationDomainEventSubscriber({ eventBus, handlers: handlersSpy() });
  const unsubscribe = subscriber.subscribe();

  unsubscribe();

  assert.deepEqual(
    eventBus.unsubscribeCalls.map(({ eventType, calls }) => [eventType, calls]),
    EVENT_MAPPINGS.map(({ eventType }) => [eventType, 1])
  );
});

test('unsubscribe returned by subscribe is idempotent', () => {
  const eventBus = eventBusSpy();
  const subscriber = createTranslationDomainEventSubscriber({ eventBus, handlers: handlersSpy() });
  const unsubscribe = subscriber.subscribe();

  unsubscribe();
  unsubscribe();
  unsubscribe();

  assert.deepEqual(
    eventBus.unsubscribeCalls.map(({ eventType, calls }) => [eventType, calls]),
    EVENT_MAPPINGS.map(({ eventType }) => [eventType, 1])
  );
});

test('multiple subscribe calls create independent subscriptions', () => {
  const eventBus = eventBusSpy();
  const subscriber = createTranslationDomainEventSubscriber({ eventBus, handlers: handlersSpy() });

  const unsubscribeA = subscriber.subscribe();
  const unsubscribeB = subscriber.subscribe();

  assert.equal(eventBus.subscriptions.length, 8);

  unsubscribeA();

  assert.deepEqual(eventBus.unsubscribeCalls.slice(0, 4).map(({ calls }) => calls), [1, 1, 1, 1]);
  assert.deepEqual(eventBus.unsubscribeCalls.slice(4).map(({ calls }) => calls), [0, 0, 0, 0]);

  unsubscribeB();

  assert.deepEqual(eventBus.unsubscribeCalls.slice(4).map(({ calls }) => calls), [1, 1, 1, 1]);
});

test('subscriber integrates with in-memory event bus and unsubscribe stops later dispatch', async () => {
  const eventBus = createInMemoryDomainEventBus();
  const received = [];
  const subscriber = createTranslationDomainEventSubscriber({
    eventBus,
    handlers: {
      requestCreated(event) {
        received.push(['requestCreated', event]);
      },
      executionCreated(event) {
        received.push(['executionCreated', event]);
      },
      executionUpdated(event) {
        received.push(['executionUpdated', event]);
      },
      outputCreated(event) {
        received.push(['outputCreated', event]);
      }
    }
  });
  const unsubscribe = subscriber.subscribe();
  const events = [
    createRequestCreatedEvent(),
    createExecutionCreatedEvent(),
    createExecutionUpdatedEvent(),
    createOutputCreatedEvent()
  ];

  for (const event of events) {
    await eventBus.publish(event);
  }

  assert.deepEqual(
    received.map(([name]) => name),
    ['requestCreated', 'executionCreated', 'executionUpdated', 'outputCreated']
  );
  assert.equal(received.every(([, event], index) => event === events[index]), true);

  unsubscribe();

  for (const event of events) {
    await eventBus.publish(event);
  }

  assert.equal(received.length, 4);
});

function eventBusSpy() {
  const subscriptions = [];
  const unsubscribeCalls = [];

  return {
    subscriptions,
    unsubscribeCalls,
    subscribe(eventType, handler) {
      let calls = 0;
      const unsubscribeRecord = {
        eventType,
        get calls() {
          return calls;
        }
      };

      subscriptions.push({ eventType, handler, unsubscribeRecord });
      unsubscribeCalls.push(unsubscribeRecord);

      return function unsubscribe() {
        calls += 1;
      };
    },
    subscriptionFor(eventType) {
      return subscriptions.find((subscription) => subscription.eventType === eventType);
    }
  };
}

function handlersSpy() {
  const calls = [];

  return {
    calls,
    requestCreated(event) {
      calls.push(['requestCreated', event]);
    },
    executionCreated(event) {
      calls.push(['executionCreated', event]);
    },
    executionUpdated(event) {
      calls.push(['executionUpdated', event]);
    },
    outputCreated(event) {
      calls.push(['outputCreated', event]);
    }
  };
}

function createRequestCreatedEvent() {
  return {
    type: TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED,
    occurredAt: 123,
    payload: {
      request: {
        id: 'request-1'
      }
    }
  };
}

function createExecutionCreatedEvent() {
  return {
    type: TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_CREATED,
    occurredAt: 124,
    payload: {
      execution: {
        id: 'execution-1'
      }
    }
  };
}

function createExecutionUpdatedEvent() {
  return {
    type: TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_UPDATED,
    occurredAt: 125,
    payload: {
      execution: {
        id: 'execution-1',
        status: 'running'
      }
    }
  };
}

function createOutputCreatedEvent() {
  return {
    type: TRANSLATION_EVENT_TYPES.TRANSLATION_OUTPUT_CREATED,
    occurredAt: 126,
    payload: {
      output: {
        id: 'output-1'
      }
    }
  };
}
