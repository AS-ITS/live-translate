export function createTranslationExecutionDispatcher(implementation = {}) {
  assertDispatcherImplementation(implementation);

  return Object.freeze({
    async dispatch({ execution, provider }) {
      return implementation.dispatch({ execution, provider });
    }
  });
}

function assertDispatcherImplementation(implementation) {
  if (!implementation || typeof implementation !== 'object') {
    throw new TypeError('translationExecutionDispatcher implementation is required.');
  }

  if (typeof implementation.dispatch !== 'function') {
    throw new TypeError('translationExecutionDispatcher.dispatch must be a function.');
  }
}
