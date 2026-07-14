import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationDomainEventPublisher } from '../../src/application/translation/domainEventPublisher.js';
import { createTranslationDomainEventPublisher as createTranslationDomainEventPublisherFromIndex } from '../../src/application/translation/index.js';
import {
  TranslationRequest,
  createTranslationRequestCreatedEvent
} from '../../src/domain/translation/index.js';

const NOT_IMPLEMENTED_ERROR = /Translation domain event publisher is not implemented/;

test('factory returns a publisher object with the publish contract', () => {
  const publisher = createTranslationDomainEventPublisher();

  assert.equal(typeof publisher, 'object');
  assert.notEqual(publisher, null);
  assert.deepEqual(Object.keys(publisher), ['publish']);
  assert.equal(typeof publisher.publish, 'function');
});

test('publisher only exposes the expected publish API', () => {
  const publisher = createTranslationDomainEventPublisher();

  assert.equal(Object.hasOwn(publisher, 'publish'), true);
  assert.equal(Object.hasOwn(publisher, 'subscribe'), false);
  assert.equal(Object.hasOwn(publisher, 'register'), false);
  assert.equal(Object.hasOwn(publisher, 'dispatch'), false);
  assert.equal(Object.hasOwn(publisher, 'flush'), false);
  assert.equal(Object.hasOwn(publisher, 'events'), false);
  assert.equal(Object.hasOwn(publisher, 'eventBus'), false);
});

test('each factory invocation returns a different publisher object', () => {
  const firstPublisher = createTranslationDomainEventPublisher();
  const secondPublisher = createTranslationDomainEventPublisher();

  assert.notEqual(firstPublisher, secondPublisher);
});

test('publish throws a deterministic not implemented error for any input', () => {
  const publisher = createTranslationDomainEventPublisher();
  const event = createRequestCreatedEvent();

  assert.throws(() => publisher.publish(event), NOT_IMPLEMENTED_ERROR);
  assert.throws(() => publisher.publish(), NOT_IMPLEMENTED_ERROR);
  assert.throws(() => publisher.publish(null), NOT_IMPLEMENTED_ERROR);
});

test('publish does not mutate a frozen WP1 domain event before throwing', () => {
  const publisher = createTranslationDomainEventPublisher();
  const event = createRequestCreatedEvent();
  const before = toPlainObject(event);

  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.payload), true);
  assert.equal(Object.isFrozen(event.payload.request), true);

  assert.throws(() => publisher.publish(event), NOT_IMPLEMENTED_ERROR);

  assert.deepEqual(toPlainObject(event), before);
});

test('publisher does not store events or expose event collection APIs', () => {
  const publisher = createTranslationDomainEventPublisher();
  const firstEvent = createRequestCreatedEvent({ id: 'request-1' });
  const secondEvent = createRequestCreatedEvent({ id: 'request-2' });

  assert.throws(() => publisher.publish(firstEvent), NOT_IMPLEMENTED_ERROR);
  assert.throws(() => publisher.publish(secondEvent), NOT_IMPLEMENTED_ERROR);

  assert.deepEqual(Object.keys(publisher), ['publish']);
  assert.equal('events' in publisher, false);
  assert.equal('publishedEvents' in publisher, false);
  assert.equal('queue' in publisher, false);
  assert.equal('bus' in publisher, false);
});

test('module does not expose subscriber, bus, or event collection API', async () => {
  const moduleExports = await import('../../src/application/translation/domainEventPublisher.js');

  assert.deepEqual(Object.keys(moduleExports), ['createTranslationDomainEventPublisher']);
});

test('translation application index exports the publisher factory', () => {
  assert.equal(createTranslationDomainEventPublisherFromIndex, createTranslationDomainEventPublisher);
  assert.equal(typeof createTranslationDomainEventPublisherFromIndex, 'function');
});

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
