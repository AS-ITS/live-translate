export function createDeadLetterQueueController({ deadLetterQueueApplicationService } = {}) {
  if (!deadLetterQueueApplicationService || typeof deadLetterQueueApplicationService.listItems !== 'function' || typeof deadLetterQueueApplicationService.replayItem !== 'function') {
    throw new TypeError('deadLetterQueueApplicationService is required.');
  }

  return Object.freeze({
    listItems() {
      return deadLetterQueueApplicationService.listItems();
    },
    replayItem(input) {
      return deadLetterQueueApplicationService.replayItem(input);
    }
  });
}
