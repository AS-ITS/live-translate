export const TRANSLATION_EVENT_TYPES = Object.freeze({
  TRANSLATION_REQUEST_CREATED: 'translation.request.created',
  TRANSLATION_EXECUTION_CREATED: 'translation.execution.created',
  TRANSLATION_EXECUTION_UPDATED: 'translation.execution.updated',
  TRANSLATION_OUTPUT_CREATED: 'translation.output.created'
});

export function createTranslationRequestCreatedEvent(input = undefined) {
  const { request, occurredAt } = assertEventInput(input, 'request');

  return createTranslationEvent(TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED, {
    occurredAt,
    payload: { request }
  });
}

export function createTranslationExecutionCreatedEvent(input = undefined) {
  const { execution, occurredAt } = assertEventInput(input, 'execution');

  return createTranslationEvent(TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_CREATED, {
    occurredAt,
    payload: { execution }
  });
}

export function createTranslationExecutionUpdatedEvent(input = undefined) {
  const { execution, occurredAt } = assertEventInput(input, 'execution');

  return createTranslationEvent(TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_UPDATED, {
    occurredAt,
    payload: { execution }
  });
}

export function createTranslationOutputCreatedEvent(input = undefined) {
  const { output, occurredAt } = assertEventInput(input, 'output');

  return createTranslationEvent(TRANSLATION_EVENT_TYPES.TRANSLATION_OUTPUT_CREATED, {
    occurredAt,
    payload: { output }
  });
}

function createTranslationEvent(type, { occurredAt, payload }) {
  return Object.freeze({
    type,
    occurredAt,
    payload: Object.freeze(payload)
  });
}

function assertEventInput(input, aggregateField) {
  assertInputObject(input, 'factory argument');

  const aggregate = assertRequiredValue(input[aggregateField], aggregateField);
  if (!isRecord(aggregate)) {
    throw new TypeError(`${aggregateField} must be an object`);
  }

  return {
    [aggregateField]: aggregate,
    occurredAt: assertTimestamp(input.occurredAt, 'occurredAt')
  };
}

function assertInputObject(value, field) {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

function assertRequiredValue(value, field) {
  if (value === null || value === undefined) {
    throw new TypeError(`${field} is required`);
  }

  return value;
}

function assertTimestamp(value, field) {
  assertRequiredValue(value, field);

  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError(`${field} must be a string or number timestamp`);
  }

  if (typeof value === 'string' && value.trim().length === 0) {
    throw new RangeError(`${field} must not be empty`);
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`${field} must be finite`);
  }

  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
