export function createSessionApplicationService({ sessionRepository, sessionReadRepository } = {}) {
  assertSessionRepository(sessionRepository);
  assertSessionReadRepository(sessionReadRepository);

  return Object.freeze({
    async createSession(input = {}) {
      return sessionRepository.createSessionRecord(input);
    },

    async updateSession(sessionId, patch = {}) {
      return sessionRepository.updateSessionRecord(sessionId, patch);
    },

    async stopSession(sessionId, patch = {}) {
      return sessionRepository.finalizeSessionRecord(sessionId, { ...patch, status: 'stopped' });
    },

    async completeSession(sessionId, patch = {}) {
      return sessionRepository.finalizeSessionRecord(sessionId, { ...patch, status: 'completed' });
    },

    async failSession(sessionId, patch = {}) {
      return sessionRepository.finalizeSessionRecord(sessionId, { ...patch, status: 'failed' });
    },

    async listSessions() {
      return sessionReadRepository.listSessionHistory();
    },

    async getSessionDetail(sessionId) {
      return sessionReadRepository.getSessionDetail(sessionId);
    }
  });
}

function assertSessionRepository(repository) {
  for (const method of ['createSessionRecord', 'updateSessionRecord', 'finalizeSessionRecord']) {
    if (!repository || typeof repository[method] !== 'function') {
      throw new TypeError(`sessionRepository.${method} is required.`);
    }
  }
}

function assertSessionReadRepository(repository) {
  for (const method of ['listSessionHistory', 'getSessionDetail']) {
    if (!repository || typeof repository[method] !== 'function') {
      throw new TypeError(`sessionReadRepository.${method} is required.`);
    }
  }
}
