import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryDomainEventBus } from '../../src/infrastructure/inMemoryDomainEventBus.js';

const EVENT_TYPE = 'translation.execution.created';
const OTHER_EVENT_TYPE = 'translation.execution.updated';
const INVALID_EVENT_TYPE_ERROR = /Domain event type must be a non-empty string/;
const INVALID_HANDLER_ERROR = /Domain event handler must be a function/;
const INVALID_EVENT_ERROR = /Domain event must be an object/;

test('module exports createInMemoryDomainEventBus factory', async () => {
  const moduleExports = await import('../../src/infrastructure/inMemoryDomainEventBus.js');

  assert.deepEqual(Object.keys(moduleExports), ['createInMemoryDomainEventBus']);
  assert.equal(moduleExports.createInMemoryDomainEventBus, createInMemoryDomainEventBus);
});

test('factory returns a bus object with subscribe and publish only', () => {
  const eventBus = createInMemoryDomainEventBus();

  assert.equal(typeof eventBus, 'object');
  assert.notEqual(eventBus, null);
  assert.equal(Object.isFrozen(eventBus), true);
  assert.deepEqual(Object.keys(eventBus), ['subscribe', 'publish']);
  assert.equal(typeof eventBus.subscribe, 'function');
  assert.equal(typeof eventBus.publish, 'function');
  assert.equal(Object.hasOwn(eventBus, 'subscriptions'), false);
  assert.equal(Object.hasOwn(eventBus, 'events'), false);
  assert.equal(Object.hasOwn(eventBus, 'unsubscribe'), false);
});

test('subscribe validates event type', () => {
  const eventBus = createInMemoryDomainEventBus();
  const handler = () => {};

  assert.throws(() => eventBus.subscribe(undefined, handler), INVALID_EVENT_TYPE_ERROR);
  assert.throws(() => eventBus.subscribe('', handler), INVALID_EVENT_TYPE_ERROR);
  assert.throws(() => eventBus.subscribe('   ', handler), INVALID_EVENT_TYPE_ERROR);
  assert.throws(() => eventBus.subscribe(123, handler), INVALID_EVENT_TYPE_ERROR);
});

test('subscribe validates handler', () => {
  const eventBus = createInMemoryDomainEventBus();

  assert.throws(() => eventBus.subscribe(EVENT_TYPE), INVALID_HANDLER_ERROR);
  assert.throws(() => eventBus.subscribe(EVENT_TYPE, null), INVALID_HANDLER_ERROR);
  assert.throws(() => eventBus.subscribe(EVENT_TYPE, 'handler'), INVALID_HANDLER_ERROR);
});

test('subscribe does not invoke or wrap the handler', async () => {
  const eventBus = createInMemoryDomainEventBus();
  let calls = 0;
  function handler() {
    calls += 1;
  }

  const unsubscribe = eventBus.subscribe(EVENT_TYPE, handler);

  assert.equal(typeof unsubscribe, 'function');
  assert.equal(calls, 0);

  await eventBus.publish(createEvent());

  assert.equal(calls, 1);
});

test('publish validates event object', async () => {
  const eventBus = createInMemoryDomainEventBus();

  await assert.rejects(eventBus.publish(), INVALID_EVENT_ERROR);
  await assert.rejects(eventBus.publish(null), INVALID_EVENT_ERROR);
  await assert.rejects(eventBus.publish('event'), INVALID_EVENT_ERROR);
  await assert.rejects(eventBus.publish([]), INVALID_EVENT_ERROR);
});

test('publish validates event type', async () => {
  const eventBus = createInMemoryDomainEventBus();

  await assert.rejects(eventBus.publish({}), INVALID_EVENT_TYPE_ERROR);
  await assert.rejects(eventBus.publish({ type: '' }), INVALID_EVENT_TYPE_ERROR);
  await assert.rejects(eventBus.publish({ type: '   ' }), INVALID_EVENT_TYPE_ERROR);
  await assert.rejects(eventBus.publish({ type: 123 }), INVALID_EVENT_TYPE_ERROR);
});

test('publish invokes handlers subscribed to the exact matching event type', async () => {
  const eventBus = createInMemoryDomainEventBus();
  const calls = [];

  eventBus.subscribe(EVENT_TYPE, (event) => calls.push(['matching', event.type]));
  eventBus.subscribe(OTHER_EVENT_TYPE, (event) => calls.push(['other', event.type]));
  eventBus.subscribe('translation.execution', (event) => calls.push(['parent', event.type]));
  eventBus.subscribe('*', (event) => calls.push(['wildcard', event.type]));

  await eventBus.publish(createEvent());

  assert.deepEqual(calls, [['matching', EVENT_TYPE]]);
});

test('publish with no matching handlers succeeds as a no-op', async () => {
  const eventBus = createInMemoryDomainEventBus();

  await assert.doesNotReject(eventBus.publish(createEvent({ type: OTHER_EVENT_TYPE })));
});

test('publish passes the original event reference and does not mutate it', async () => {
  const eventBus = createInMemoryDomainEventBus();
  const event = createEvent();
  const before = structuredClone(event);
  const receivedEvents = [];

  eventBus.subscribe(EVENT_TYPE, (receivedEvent) => receivedEvents.push(receivedEvent));
  eventBus.subscribe(EVENT_TYPE, (receivedEvent) => receivedEvents.push(receivedEvent));

  await eventBus.publish(event);

  assert.equal(receivedEvents.length, 2);
  assert.strictEqual(receivedEvents[0], event);
  assert.strictEqual(receivedEvents[1], event);
  assert.deepEqual(event, before);
});

test('publish invokes all matching handlers in subscription order', async () => {
  const eventBus = createInMemoryDomainEventBus();
  const event = createEvent();
  const calls = [];

  eventBus.subscribe(EVENT_TYPE, (receivedEvent) => calls.push(['first', receivedEvent]));
  eventBus.subscribe(EVENT_TYPE, (receivedEvent) => calls.push(['second', receivedEvent]));
  eventBus.subscribe(EVENT_TYPE, (receivedEvent) => calls.push(['third', receivedEvent]));

  await eventBus.publish(event);

  assert.deepEqual(
    calls.map(([name]) => name),
    ['first', 'second', 'third']
  );
  assert.equal(calls.every(([, receivedEvent]) => receivedEvent === event), true);
});

test('duplicate subscriptions are invoked independently', async () => {
  const eventBus = createInMemoryDomainEventBus();
  let calls = 0;
  const handler = () => {
    calls += 1;
  };

  eventBus.subscribe(EVENT_TYPE, handler);
  eventBus.subscribe(EVENT_TYPE, handler);

  await eventBus.publish(createEvent());

  assert.equal(calls, 2);
});

test('unsubscribing one duplicate leaves the other duplicate active', async () => {
  const eventBus = createInMemoryDomainEventBus();
  let calls = 0;
  const handler = () => {
    calls += 1;
  };

  const unsubscribeFirst = eventBus.subscribe(EVENT_TYPE, handler);
  eventBus.subscribe(EVENT_TYPE, handler);

  unsubscribeFirst();
  await eventBus.publish(createEvent());

  assert.equal(calls, 1);
});

test('unsubscribe prevents future invocation and is safe to repeat', async () => {
  const eventBus = createInMemoryDomainEventBus();
  let calls = 0;
  const unsubscribe = eventBus.subscribe(EVENT_TYPE, () => {
    calls += 1;
  });

  unsubscribe();
  unsubscribe();
  await eventBus.publish(createEvent());

  assert.equal(calls, 0);
});

test('unsubscribe removes only its own subscription', async () => {
  const eventBus = createInMemoryDomainEventBus();
  const calls = [];
  const unsubscribeFirst = eventBus.subscribe(EVENT_TYPE, () => calls.push('first'));
  eventBus.subscribe(EVENT_TYPE, () => calls.push('second'));

  unsubscribeFirst();
  await eventBus.publish(createEvent());

  assert.deepEqual(calls, ['second']);
});

test('unsubscribe does not invoke the handler', () => {
  const eventBus = createInMemoryDomainEventBus();
  let calls = 0;
  const unsubscribe = eventBus.subscribe(EVENT_TYPE, () => {
    calls += 1;
  });

  unsubscribe();

  assert.equal(calls, 0);
});

test('publish waits for asynchronous handlers and resolves after all complete', async () => {
  const eventBus = createInMemoryDomainEventBus();
  const calls = [];

  eventBus.subscribe(EVENT_TYPE, async () => {
    await Promise.resolve();
    calls.push('first-complete');
  });
  eventBus.subscribe(EVENT_TYPE, () => {
    calls.push('second-complete');
  });

  const result = await eventBus.publish(createEvent());

  assert.equal(result, undefined);
  assert.deepEqual(calls, ['first-complete', 'second-complete']);
});

test('publish maintains sequential order across asynchronous handlers', async () => {
  const eventBus = createInMemoryDomainEventBus();
  const calls = [];
  let releaseFirstHandler;

  eventBus.subscribe(EVENT_TYPE, async () => {
    calls.push('first-start');
    await new Promise((resolve) => {
      releaseFirstHandler = resolve;
    });
    calls.push('first-end');
  });
  eventBus.subscribe(EVENT_TYPE, () => {
    calls.push('second');
  });

  const publishPromise = eventBus.publish(createEvent());
  await Promise.resolve();

  assert.deepEqual(calls, ['first-start']);

  releaseFirstHandler();
  await publishPromise;

  assert.deepEqual(calls, ['first-start', 'first-end', 'second']);
});

test('publish propagates the exact synchronous handler error and stops dispatch', async () => {
  const eventBus = createInMemoryDomainEventBus();
  const expectedError = new Error('subscriber failed');
  let laterHandlerCalled = false;

  eventBus.subscribe(EVENT_TYPE, () => {
    throw expectedError;
  });
  eventBus.subscribe(EVENT_TYPE, () => {
    laterHandlerCalled = true;
  });

  await assert.rejects(eventBus.publish(createEvent()), (actualError) => actualError === expectedError);
  assert.equal(laterHandlerCalled, false);
});

test('publish propagates the exact asynchronous rejection and stops dispatch', async () => {
  const eventBus = createInMemoryDomainEventBus();
  const expectedError = new Error('subscriber rejected');
  let laterHandlerCalled = false;

  eventBus.subscribe(EVENT_TYPE, async () => {
    throw expectedError;
  });
  eventBus.subscribe(EVENT_TYPE, () => {
    laterHandlerCalled = true;
  });

  await assert.rejects(eventBus.publish(createEvent()), (actualError) => actualError === expectedError);
  assert.equal(laterHandlerCalled, false);
});

test('subscription added during publication does not run in the same publication', async () => {
  const eventBus = createInMemoryDomainEventBus();
  const calls = [];

  eventBus.subscribe(EVENT_TYPE, () => {
    calls.push('first');
    eventBus.subscribe(EVENT_TYPE, () => calls.push('added'));
  });

  await eventBus.publish(createEvent());

  assert.deepEqual(calls, ['first']);

  await eventBus.publish(createEvent());

  assert.deepEqual(calls, ['first', 'first', 'added']);
});

test('unsubscribe during publication does not alter the current publication snapshot', async () => {
  const eventBus = createInMemoryDomainEventBus();
  const calls = [];
  let unsubscribeSecond;

  eventBus.subscribe(EVENT_TYPE, () => {
    calls.push('first');
    unsubscribeSecond();
  });
  unsubscribeSecond = eventBus.subscribe(EVENT_TYPE, () => {
    calls.push('second');
  });

  await eventBus.publish(createEvent());

  assert.deepEqual(calls, ['first', 'second']);

  await eventBus.publish(createEvent());

  assert.deepEqual(calls, ['first', 'second', 'first']);
});

test('separate event bus instances do not share subscriptions', async () => {
  const firstBus = createInMemoryDomainEventBus();
  const secondBus = createInMemoryDomainEventBus();
  const calls = [];

  firstBus.subscribe(EVENT_TYPE, () => calls.push('first-bus'));
  secondBus.subscribe(EVENT_TYPE, () => calls.push('second-bus'));

  await firstBus.publish(createEvent());

  assert.deepEqual(calls, ['first-bus']);
});

function createEvent(overrides = {}) {
  return {
    type: overrides.type ?? EVENT_TYPE,
    occurredAt: overrides.occurredAt ?? 'occurred-at',
    payload: overrides.payload ?? {
      execution: {
        id: 'execution-1',
        requestId: 'request-1'
      }
    }
  };
}
