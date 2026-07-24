export function createRetranslationSessionMaterializer({ sessionRepository } = {}) {
  assertSessionRepository(sessionRepository);

  return Object.freeze({
    async materialize({ output } = {}) {
      if (!isRecord(output) || typeof output.executionId !== 'string' || typeof output.sessionId !== 'string') {
        return null;
      }

      await maybeAwait(sessionRepository.getSessionRecord(output.sessionId));
      return null;
    }
  });
}

function assertSessionRepository(sessionRepository) {
  if (!sessionRepository || typeof sessionRepository !== 'object') {
    throw new TypeError('sessionRepository is required.');
  }

  for (const method of ['getSessionRecord']) {
    if (typeof sessionRepository[method] !== 'function') {
      throw new TypeError(`sessionRepository.${method} must be a function.`);
    }
  }
}

function maybeAwait(value) {
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
