const INVALID_EVENT_TYPE_MESSAGE = 'Domain event type must be a non-empty string';
const INVALID_HANDLER_MESSAGE = 'Domain event handler must be a function';
const INVALID_EVENT_MESSAGE = 'Domain event must be an object';

export function createInMemoryDomainEventBus() {
  const subscriptionsByEventType = new Map();

  return Object.freeze({
    subscribe(eventType, handler) {
      assertEventType(eventType);
      assertHandler(handler);

      const entry = { handler };
      const entries = subscriptionsByEventType.get(eventType) ?? [];
      entries.push(entry);
      subscriptionsByEventType.set(eventType, entries);

      let unsubscribed = false;
      return function unsubscribe() {
        if (unsubscribed) {
          return;
        }

        unsubscribed = true;
        const currentEntries = subscriptionsByEventType.get(eventType);
        if (!currentEntries) {
          return;
        }

        const entryIndex = currentEntries.indexOf(entry);
        if (entryIndex !== -1) {
          currentEntries.splice(entryIndex, 1);
        }

        if (currentEntries.length === 0) {
          subscriptionsByEventType.delete(eventType);
        }
      };
    },

    async publish(event) {
      assertEvent(event);

      const subscriptions = subscriptionsByEventType.get(event.type);
      if (!subscriptions || subscriptions.length === 0) {
        return undefined;
      }

      const publicationSnapshot = subscriptions.slice();
      for (const { handler } of publicationSnapshot) {
        await handler(event);
      }

      return undefined;
    }
  });
}

function assertEvent(event) {
  if (!isRecord(event)) {
    throw new TypeError(INVALID_EVENT_MESSAGE);
  }

  assertEventType(event.type);
}

function assertEventType(eventType) {
  if (typeof eventType !== 'string' || eventType.trim().length === 0) {
    throw new TypeError(INVALID_EVENT_TYPE_MESSAGE);
  }
}

function assertHandler(handler) {
  if (typeof handler !== 'function') {
    throw new TypeError(INVALID_HANDLER_MESSAGE);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
