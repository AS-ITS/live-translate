const MODES = Object.freeze(['resolve', 'reject', 'throw', 'deferred']);

export function createFakeSavedTranscriptTranslationProvider(options = {}) {
  assertOptions(options);

  const hasResult = Object.hasOwn(options, 'result');
  const hasError = Object.hasOwn(options, 'error');
  const mode = options.mode ?? (hasError ? 'reject' : 'resolve');
  assertMode(mode);

  if (hasResult && hasError) {
    throw new TypeError('result and error cannot both be configured.');
  }

  if ((mode === 'reject' || mode === 'throw') && !hasError) {
    throw new TypeError(`error is required for ${mode} mode.`);
  }

  if (mode === 'deferred') {
    assertDeferred(options.deferred);
  }

  const calls = [];

  return Object.freeze({
    translate(input) {
      calls.push(input);

      switch (mode) {
        case 'resolve':
          return Promise.resolve(options.result);
        case 'reject':
          return Promise.reject(options.error);
        case 'throw':
          throw options.error;
        case 'deferred':
          return options.deferred.promise;
        default:
          throw new TypeError(`Unsupported fake saved transcript translation provider mode: ${mode}`);
      }
    },

    getCalls() {
      return [...calls];
    }
  });
}

function assertOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object.');
  }
}

function assertMode(mode) {
  if (!MODES.includes(mode)) {
    throw new RangeError(`Unsupported fake saved transcript translation provider mode: ${mode}`);
  }
}

function assertDeferred(deferred) {
  if (!deferred || typeof deferred !== 'object' || Array.isArray(deferred)) {
    throw new TypeError('deferred must be an object.');
  }

  if (!deferred.promise || typeof deferred.promise.then !== 'function') {
    throw new TypeError('deferred.promise must be a Promise-like object.');
  }

  if (Object.hasOwn(deferred, 'resolve') && typeof deferred.resolve !== 'function') {
    throw new TypeError('deferred.resolve must be a function.');
  }

  if (Object.hasOwn(deferred, 'reject') && typeof deferred.reject !== 'function') {
    throw new TypeError('deferred.reject must be a function.');
  }
}
