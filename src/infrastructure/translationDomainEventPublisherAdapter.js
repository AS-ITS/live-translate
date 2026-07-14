export function createTranslationDomainEventPublisherAdapter({ eventBus } = {}) {
  assertEventBus(eventBus);

  return Object.freeze({
    publish(event) {
      return eventBus.publish(event);
    }
  });
}

function assertEventBus(eventBus) {
  if (!eventBus || typeof eventBus !== 'object') {
    throw new TypeError('eventBus is required.');
  }

  if (typeof eventBus.publish !== 'function') {
    throw new TypeError('eventBus.publish must be a function.');
  }
}
