export const DEFAULT_DURABLE_TRANSLATION_QUEUE_FILE = 'translation-execution-queue.json';

export function createTranslationQueueConfiguration(input) {
  assertFactoryInput(arguments.length, input);

  const { environment } = input;
  assertEnvironment(environment);

  return Object.freeze({
    durableQueueEnabled: readDurableQueueEnabled(environment),
    durableQueueFilePath: readDurableQueueFilePath(environment)
  });
}

function assertFactoryInput(argumentCount, input) {
  if (argumentCount === 0 || input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('factory input must be an object with environment.');
  }

  if (!Object.hasOwn(input, 'environment')) {
    throw new TypeError('environment is required.');
  }
}

function assertEnvironment(environment) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new TypeError('environment must be an object.');
  }
}

function readDurableQueueEnabled(environment) {
  const value = environment.TRANSLATION_DURABLE_QUEUE_ENABLED;

  if (value === undefined) {
    return false;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    throw new TypeError('TRANSLATION_DURABLE_QUEUE_ENABLED must be a boolean string.');
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false' || normalized.length === 0) {
    return false;
  }

  throw new TypeError('TRANSLATION_DURABLE_QUEUE_ENABLED must be true or false.');
}

function readDurableQueueFilePath(environment) {
  const value = environment.TRANSLATION_DURABLE_QUEUE_FILE;

  if (value === undefined) {
    return DEFAULT_DURABLE_TRANSLATION_QUEUE_FILE;
  }

  if (typeof value !== 'string') {
    throw new TypeError('TRANSLATION_DURABLE_QUEUE_FILE must be a string.');
  }

  if (value.trim().length === 0) {
    throw new TypeError('TRANSLATION_DURABLE_QUEUE_FILE must be a non-empty string.');
  }

  return value;
}
