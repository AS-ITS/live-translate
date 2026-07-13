export function createSessionReadController({ sessionQueryService } = {}) {
  assertSessionQueryService(sessionQueryService);

  return {
    listSessions() {
      return sessionQueryService.listSessionHistory();
    },

    getSession(sessionId) {
      return sessionQueryService.getSessionDetail(sessionId);
    }
  };
}

function assertSessionQueryService(sessionQueryService) {
  if (!sessionQueryService) {
    throw new TypeError('sessionQueryService is required.');
  }

  assertMethod(sessionQueryService, 'listSessionHistory');
  assertMethod(sessionQueryService, 'getSessionDetail');
}

function assertMethod(target, methodName) {
  if (typeof target[methodName] !== 'function') {
    throw new TypeError(`sessionQueryService.${methodName} must be a function.`);
  }
}
