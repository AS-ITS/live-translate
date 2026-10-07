export function createLocalRecorderLock({ locks = globalThis.navigator?.locks, namePrefix = 'live-translate:meeting:' } = {}) {
  if (!locks || typeof locks.request !== 'function') {
    return Object.freeze({
      available: false,
      async run() {
        const error = new Error('Browser recorder lock is unavailable.');
        error.code = 'recorder_lock_unavailable';
        error.status = 503;
        throw error;
      }
    });
  }

  return Object.freeze({
    available: true,
    async run(meetingId, work) {
      if (typeof work !== 'function') throw new TypeError('lock work must be a function.');
      if (typeof meetingId !== 'string' || meetingId.trim() === '') throw new TypeError('meetingId is required.');
      let acquired = false;
      const result = await locks.request(
        `${namePrefix}${meetingId}`,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (!lock) return undefined;
          acquired = true;
          return work();
        }
      );
      if (!acquired) {
        const error = new Error('Another recorder is active for this Meeting.');
        error.code = 'recorder_already_active';
        error.status = 409;
        throw error;
      }
      return result;
    }
  });
}
