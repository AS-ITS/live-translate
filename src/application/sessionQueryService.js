export function createSessionQueryService({ sessionReadRepository } = {}) {
  assertSessionReadRepository(sessionReadRepository);

  return {
    listSessionHistory() {
      return sessionReadRepository.listSessionHistory();
    },

    getSessionDetail(sessionId) {
      return sessionReadRepository.getSessionDetail(sessionId);
    }
  };
}

function assertSessionReadRepository(sessionReadRepository) {
  if (!sessionReadRepository) {
    throw new TypeError('sessionReadRepository is required.');
  }

  assertMethod(sessionReadRepository, 'listSessionHistory');
  assertMethod(sessionReadRepository, 'getSessionDetail');
}

function assertMethod(target, methodName) {
  if (typeof target[methodName] !== 'function') {
    throw new TypeError(`sessionReadRepository.${methodName} must be a function.`);
  }
}
