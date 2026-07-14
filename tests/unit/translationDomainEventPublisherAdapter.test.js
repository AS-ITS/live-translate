import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationDomainEventPublisherAdapter } from '../../src/infrastructure/translationDomainEventPublisherAdapter.js';
import {
  TranslationRequest,
  createTranslationRequestCreatedEvent
} from '../../src/domain/translation/index.js';

test('factory returns a frozen publisher adapter with only publish', () => {
  const adapter = createTranslationDomainEventPublisherAdapter({ eventBus: eventBusStub() });

  assert.equal(typeof adapter, 'object');
  assert.notEqual(adapter, null);
  assert.equal(Object.isFrozen(adapter), true);
  assert.deepEqual(Object.keys(adapter), ['publish']);
  assert.equal(typeof adapter.publish, 'function');
  assert.equal(Object.hasOwn(adapter, 'subscribe'), false);
  assert.equal(Object.hasOwn(adapter, 'register'), false);
  assert.equal(Object.hasOwn(adapter, 'dispatch'), false);
  assert.equal(Object.hasOwn(adapter, 'flush'), false);
  assert.equal(Object.hasOwn(adapter, 'events'), false);
});

test('factory validates eventBus dependency immediately', () => {
  assert.throws(() => createTranslationDomainEventPublisherAdapter(), /eventBus is required/);
  assert.throws(() => createTranslationDomainEventPublisherAdapter({}), /eventBus is required/);
  assert.throws(() => createTranslationDomainEventPublisherAdapter({ eventBus: null }), /eventBus is required/);
  assert.throws(() => createTranslationDomainEventPublisherAdapter({ eventBus: 'invalid' }), /eventBus is required/);
  assert.throws(() => createTranslationDomainEventPublisherAdapter({ eventBus: [] }), /eventBus\.publish must be a function/);
  assert.throws(
    () => createTranslationDomainEventPublisherAdapter({ eventBus: {} }),
    /eventBus\.publish must be a function/
  );
  assert.throws(
    () => createTranslationDomainEventPublisherAdapter({ eventBus: { publish: true } }),
    /eventBus\.publish must be a function/
  );
});

test('publish delegates the exact event reference once with no extra arguments', () => {
  const calls = [];
  const result = { published: true };
  const eventBus = {
    publish(...args) {
      calls.push(args);
      return result;
    }
  };
  const adapter = createTranslationDomainEventPublisherAdapter({ eventBus });
  const event = createRequestCreatedEvent();

  const actual = adapter.publish(event);

  assert.strictEqual(actual, result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.strictEqual(calls[0][0], event);
});

test('publish does not mutate event or payload', () => {
  const eventBus = eventBusStub();
  const adapter = createTranslationDomainEventPublisherAdapter({ eventBus });
  const event = createRequestCreatedEvent();
  const before = toPlainObject(event);

  adapter.publish(event);

  assert.deepEqual(toPlainObject(event), before);
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.payload), true);
  assert.equal(Object.isFrozen(event.payload.request), true);
  assert.strictEqual(eventBus.calls[0][0], event);
});

test('publish delegates every call without storing events', () => {
  const eventBus = eventBusStub();
  const adapter = createTranslationDomainEventPublisherAdapter({ eventBus });
  const firstEvent = createRequestCreatedEvent({ id: 'request-1' });
  const secondEvent = createRequestCreatedEvent({ id: 'request-2' });

  adapter.publish(firstEvent);
  adapter.publish(secondEvent);

  assert.equal(eventBus.calls.length, 2);
  assert.strictEqual(eventBus.calls[0][0], firstEvent);
  assert.strictEqual(eventBus.calls[1][0], secondEvent);
  assert.deepEqual(Object.keys(adapter), ['publish']);
  assert.equal('events' in adapter, false);
  assert.equal('publishedEvents' in adapter, false);
  assert.equal('queue' in adapter, false);
  assert.equal('bus' in adapter, false);
});

test('publish returns synchronous event bus result unchanged', () => {
  const result = Object.freeze({ status: 'accepted' });
  const adapter = createTranslationDomainEventPublisherAdapter({
    eventBus: {
      publish() {
        return result;
      }
    }
  });

  assert.strictEqual(adapter.publish(createRequestCreatedEvent()), result);
});

test('publish returns promise event bus result by reference', () => {
  const promise = Promise.resolve({ status: 'accepted' });
  const adapter = createTranslationDomainEventPublisherAdapter({
    eventBus: {
      publish() {
        return promise;
      }
    }
  });

  assert.strictEqual(adapter.publish(createRequestCreatedEvent()), promise);
});

test('publish propagates synchronous event bus errors unchanged', () => {
  const error = new Error('event bus failed');
  const adapter = createTranslationDomainEventPublisherAdapter({
    eventBus: {
      publish() {
        throw error;
      }
    }
  });

  assert.throws(() => adapter.publish(createRequestCreatedEvent()), (actualError) => actualError === error);
});

test('publish propagates rejected promises without wrapping', async () => {
  const error = new Error('event bus rejected');
  const promise = Promise.reject(error);
  const adapter = createTranslationDomainEventPublisherAdapter({
    eventBus: {
      publish() {
        return promise;
      }
    }
  });
  const result = adapter.publish(createRequestCreatedEvent());

  assert.strictEqual(result, promise);
  await assert.rejects(result, (actualError) => actualError === error);
});

function eventBusStub() {
  const calls = [];

  return {
    calls,
    publish(...args) {
      calls.push(args);
      return undefined;
    }
  };
}

function createRequestCreatedEvent(overrides = {}) {
  return createTranslationRequestCreatedEvent({
    request: new TranslationRequest({
      id: overrides.id ?? 'request-1',
      sessionId: 'session-1',
      sourceTranscriptRevisionId: 'source-revision-1',
      targetLanguageCode: 'zh-Hant',
      sourceTranscriptSnapshot: {
        revisionId: 'source-revision-1',
        items: [{ text: 'hello', sequence: 0 }]
      },
      createdAt: 1000
    }),
    occurredAt: 'occurred-at'
  });
}

function toPlainObject(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(toPlainObject);
  }

  return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [key, toPlainObject(nestedValue)]));
}
