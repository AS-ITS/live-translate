import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRANSLATION_EVENT_TYPES,
  TRANSLATION_EXECUTION_STATUSES,
  TranslationExecution,
  TranslationOutput,
  TranslationRequest,
  createTranslationExecutionCreatedEvent,
  createTranslationExecutionUpdatedEvent,
  createTranslationOutputCreatedEvent,
  createTranslationRequestCreatedEvent
} from '../../src/domain/translation/index.js';

const FACTORIES = Object.freeze([
  {
    name: 'TranslationRequestCreated',
    factory: createTranslationRequestCreatedEvent,
    aggregateField: 'request',
    type: TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED,
    createAggregate: createRequest
  },
  {
    name: 'TranslationExecutionCreated',
    factory: createTranslationExecutionCreatedEvent,
    aggregateField: 'execution',
    type: TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_CREATED,
    createAggregate: createExecution
  },
  {
    name: 'TranslationExecutionUpdated',
    factory: createTranslationExecutionUpdatedEvent,
    aggregateField: 'execution',
    type: TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_UPDATED,
    createAggregate: createExecution
  },
  {
    name: 'TranslationOutputCreated',
    factory: createTranslationOutputCreatedEvent,
    aggregateField: 'output',
    type: TRANSLATION_EVENT_TYPES.TRANSLATION_OUTPUT_CREATED,
    createAggregate: createOutput
  }
]);

test('translation event types are stable', () => {
  assert.equal(TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED, 'translation.request.created');
  assert.equal(TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_CREATED, 'translation.execution.created');
  assert.equal(TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_UPDATED, 'translation.execution.updated');
  assert.equal(TRANSLATION_EVENT_TYPES.TRANSLATION_OUTPUT_CREATED, 'translation.output.created');
  assert.equal(Object.isFrozen(TRANSLATION_EVENT_TYPES), true);
});

test('each factory returns the expected event type and payload shape', () => {
  for (const { factory, aggregateField, type, createAggregate } of FACTORIES) {
    const aggregate = createAggregate();
    const event = factory({ [aggregateField]: aggregate, occurredAt: 'occurred-at' });

    assert.deepEqual(Object.keys(event), ['type', 'occurredAt', 'payload']);
    assert.equal(event.type, type);
    assert.equal(event.occurredAt, 'occurred-at');
    assert.deepEqual(event.payload, { [aggregateField]: aggregate });
    assert.strictEqual(event.payload[aggregateField], aggregate);
  }
});

test('occurredAt is preserved without conversion', () => {
  const stringEvent = createTranslationRequestCreatedEvent({
    request: createRequest(),
    occurredAt: '2026-07-14T09:00:00.000Z'
  });
  const numberEvent = createTranslationRequestCreatedEvent({
    request: createRequest(),
    occurredAt: 12345
  });

  assert.equal(stringEvent.occurredAt, '2026-07-14T09:00:00.000Z');
  assert.equal(numberEvent.occurredAt, 12345);
});

test('aggregate payload content is preserved without adding domain fields', () => {
  const request = createRequest({
    sourceTranscriptSnapshot: {
      revisionId: 'source-revision-1',
      items: [{ text: 'hello', sequence: 0 }]
    }
  });
  const event = createTranslationRequestCreatedEvent({ request, occurredAt: 1000 });

  assert.strictEqual(event.payload.request, request);
  assert.deepEqual(Object.keys(event.payload.request), [
    'id',
    'sessionId',
    'sourceTranscriptRevisionId',
    'targetLanguageCode',
    'sourceTranscriptSnapshot',
    'createdAt'
  ]);
});

test('events and payload containers are frozen while aggregate references are preserved', () => {
  const request = createRequest({
    sourceTranscriptSnapshot: {
      revisionId: 'source-revision-1',
      items: [{ text: 'hello', tokens: ['hello'] }]
    }
  });
  const event = createTranslationRequestCreatedEvent({ request, occurredAt: 1000 });

  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.payload), true);
  assert.strictEqual(event.payload.request, request);
  assert.equal(Object.isFrozen(event.payload.request), true);
  assert.equal(Object.isFrozen(event.payload.request.sourceTranscriptSnapshot), true);
  assert.equal(Object.isFrozen(event.payload.request.sourceTranscriptSnapshot.items), true);
  assert.equal(Object.isFrozen(event.payload.request.sourceTranscriptSnapshot.items[0]), true);
  assert.equal(Object.isFrozen(event.payload.request.sourceTranscriptSnapshot.items[0].tokens), true);
});

test('event payload preserves aggregate object identity', () => {
  const request = {
    id: 'request-1',
    nested: {
      items: [{ text: 'hello', tags: ['source'] }]
    }
  };
  const event = createTranslationRequestCreatedEvent({ request, occurredAt: 1000 });

  assert.strictEqual(event.payload.request, request);
  assert.strictEqual(event.payload.request.nested, request.nested);
  assert.strictEqual(event.payload.request.nested.items, request.nested.items);
  assert.strictEqual(event.payload.request.nested.items[0], request.nested.items[0]);
  assert.strictEqual(event.payload.request.nested.items[0].tags, request.nested.items[0].tags);
  assert.deepEqual(event.payload.request, request);
});

test('mutating a mutable aggregate reference after event creation is reflected in the event payload', () => {
  const request = {
    id: 'request-1',
    nested: {
      items: [{ text: 'hello', tags: ['source'] }]
    }
  };
  const event = createTranslationRequestCreatedEvent({ request, occurredAt: 1000 });

  request.id = 'changed';
  request.nested.items[0].text = 'changed';
  request.nested.items[0].tags.push('changed');
  request.nested.items.push({ text: 'later' });

  assert.strictEqual(event.payload.request, request);
  assert.deepEqual(event.payload.request, {
    id: 'changed',
    nested: {
      items: [{ text: 'changed', tags: ['source', 'changed'] }, { text: 'later' }]
    }
  });
});

test('attempting to mutate an event does not change it', () => {
  const event = createTranslationOutputCreatedEvent({
    output: createOutput({ providerMetadata: { warnings: ['low-confidence'] } }),
    occurredAt: 1000
  });

  assert.throws(() => {
    event.type = 'changed';
  }, TypeError);
  assert.throws(() => {
    event.payload.output.providerMetadata.warnings.push('changed');
  }, TypeError);

  assert.equal(event.type, TRANSLATION_EVENT_TYPES.TRANSLATION_OUTPUT_CREATED);
  assert.deepEqual(event.payload.output.providerMetadata.warnings, ['low-confidence']);
});

test('factory does not mutate the original input object', () => {
  const input = {
    request: {
      id: 'request-1',
      nested: {
        items: [{ text: 'hello' }]
      }
    },
    occurredAt: 1000
  };
  const before = structuredClone(input);

  createTranslationRequestCreatedEvent(input);

  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input.request), false);
  assert.equal(Object.isFrozen(input.request.nested), false);
});

for (const { name, factory, aggregateField, createAggregate } of FACTORIES) {
  test(`${name} validates missing factory argument`, () => {
    assert.throws(() => factory(), TypeError);
  });

  test(`${name} validates missing aggregate payload`, () => {
    assert.throws(() => factory({ occurredAt: 1000 }), TypeError);
  });

  test(`${name} validates invalid aggregate payload`, () => {
    assert.throws(() => factory({ [aggregateField]: 'invalid', occurredAt: 1000 }), TypeError);
    assert.throws(() => factory({ [aggregateField]: [], occurredAt: 1000 }), TypeError);
  });

  test(`${name} validates missing occurredAt`, () => {
    assert.throws(() => factory({ [aggregateField]: createAggregate() }), TypeError);
  });

  test(`${name} validates invalid occurredAt`, () => {
    assert.throws(() => factory({ [aggregateField]: createAggregate(), occurredAt: true }), TypeError);
  });
}

test('translation index exports WP1 event API without breaking existing exports', () => {
  assert.equal(typeof createTranslationRequestCreatedEvent, 'function');
  assert.equal(typeof createTranslationExecutionCreatedEvent, 'function');
  assert.equal(typeof createTranslationExecutionUpdatedEvent, 'function');
  assert.equal(typeof createTranslationOutputCreatedEvent, 'function');
  assert.equal(TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED, 'translation.request.created');

  assert.equal(typeof TranslationRequest, 'function');
  assert.equal(typeof TranslationExecution, 'function');
  assert.equal(typeof TranslationOutput, 'function');
  assert.deepEqual(TRANSLATION_EXECUTION_STATUSES, ['pending', 'running', 'completed', 'failed', 'cancelled']);
});

function createRequest(overrides = {}) {
  return new TranslationRequest({
    id: 'request-1',
    sessionId: 'session-1',
    sourceTranscriptRevisionId: 'source-revision-1',
    targetLanguageCode: 'zh-Hant',
    createdAt: 1000,
    ...overrides
  });
}

function createExecution(overrides = {}) {
  return new TranslationExecution({
    id: 'execution-1',
    translationRequestId: 'request-1',
    startedAt: 1000,
    ...overrides
  });
}

function createOutput(overrides = {}) {
  return new TranslationOutput({
    id: 'output-1',
    executionId: 'execution-1',
    sequence: 0,
    translatedText: 'translated text',
    targetLanguageCode: 'ja',
    createdAt: 1000,
    ...overrides
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
