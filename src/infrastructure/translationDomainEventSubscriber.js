import { TRANSLATION_EVENT_TYPES } from '../domain/translation/index.js';

const HANDLER_MAPPINGS = Object.freeze([
  Object.freeze({
    eventType: TRANSLATION_EVENT_TYPES.TRANSLATION_REQUEST_CREATED,
    handlerName: 'requestCreated'
  }),
  Object.freeze({
    eventType: TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_CREATED,
    handlerName: 'executionCreated'
  }),
  Object.freeze({
    eventType: TRANSLATION_EVENT_TYPES.TRANSLATION_EXECUTION_UPDATED,
    handlerName: 'executionUpdated'
  }),
  Object.freeze({
    eventType: TRANSLATION_EVENT_TYPES.TRANSLATION_OUTPUT_CREATED,
    handlerName: 'outputCreated'
  })
]);

const NOOP_HANDLER = () => undefined;

export function createTranslationDomainEventSubscriber({ eventBus, handlers = {} } = {}) {
  assertEventBus(eventBus);
  assertHandlers(handlers);

  const resolvedHandlers = Object.fromEntries(
    HANDLER_MAPPINGS.map(({ handlerName }) => [handlerName, handlers[handlerName] || NOOP_HANDLER])
  );

  return Object.freeze({
    subscribe() {
      const unsubscribers = HANDLER_MAPPINGS.map(({ eventType, handlerName }) =>
        eventBus.subscribe(eventType, (event) => resolvedHandlers[handlerName](event))
      );

      let unsubscribed = false;
      return function unsubscribeAll() {
        if (unsubscribed) {
          return;
        }

        unsubscribed = true;
        for (const unsubscribe of unsubscribers) {
          unsubscribe();
        }
      };
    }
  });
}

function assertEventBus(eventBus) {
  if (!eventBus || typeof eventBus !== 'object') {
    throw new TypeError('eventBus is required.');
  }

  if (typeof eventBus.subscribe !== 'function') {
    throw new TypeError('eventBus.subscribe must be a function.');
  }
}

function assertHandlers(handlers) {
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
    throw new TypeError('handlers must be an object.');
  }

  for (const { handlerName } of HANDLER_MAPPINGS) {
    if (Object.hasOwn(handlers, handlerName) && typeof handlers[handlerName] !== 'function') {
      throw new TypeError(`handlers.${handlerName} must be a function.`);
    }
  }
}
