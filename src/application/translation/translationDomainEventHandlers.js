async function requestCreated() {}

async function executionCreated() {}

async function executionUpdated() {}

async function outputCreated() {}

export function createTranslationDomainEventHandlers() {
  return Object.freeze({
    requestCreated,
    executionCreated,
    executionUpdated,
    outputCreated
  });
}
