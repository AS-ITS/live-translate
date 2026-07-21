export const DEFAULT_DURABLE_TRANSLATION_QUEUE_FILE = 'translation-execution-queue.json';
export const DEFAULT_DEAD_LETTER_QUEUE_FILE = 'translation-execution-dead-letter-queue.json';
export const DEFAULT_TRANSLATION_QUEUE_LEASE_MS = 300000;
export const DEFAULT_TRANSLATION_QUEUE_LEASE_RENEWAL_MS = 100000;

export function createTranslationQueueConfiguration(input) {
  assertFactoryInput(arguments.length, input);

  const { environment } = input;
  assertEnvironment(environment);

  return Object.freeze({
    durableQueueEnabled: readDurableQueueEnabled(environment),
    durableQueueFilePath: readDurableQueueFilePath(environment),
    deadLetterQueueFilePath: readDeadLetterQueueFilePath(environment),
    leaseMs: readLeaseMs(environment),
    leaseRenewalMs: readLeaseRenewalMs(environment)
  });
}

function readLeaseRenewalMs(environment) {
  const value = environment.TRANSLATION_QUEUE_LEASE_RENEWAL_MS;
  const parsed = value === undefined || value === '' ? DEFAULT_TRANSLATION_QUEUE_LEASE_RENEWAL_MS : Number(value);
  const leaseMs = readLeaseMs(environment);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= leaseMs) {
    throw new TypeError('TRANSLATION_QUEUE_LEASE_RENEWAL_MS must be a positive integer lower than TRANSLATION_QUEUE_LEASE_MS.');
  }
  return parsed;
}

function readLeaseMs(environment) {
  const value = environment.TRANSLATION_QUEUE_LEASE_MS;
  if (value === undefined || value === '') return DEFAULT_TRANSLATION_QUEUE_LEASE_MS;
  if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError('TRANSLATION_QUEUE_LEASE_MS must be a positive integer.');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new TypeError('TRANSLATION_QUEUE_LEASE_MS must be a positive integer.');
  return parsed;
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

function readDeadLetterQueueFilePath(environment) {
  const value = environment.TRANSLATION_DEAD_LETTER_QUEUE_FILE;
  if (value === undefined) return DEFAULT_DEAD_LETTER_QUEUE_FILE;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('TRANSLATION_DEAD_LETTER_QUEUE_FILE must be a non-empty string.');
  }
  return value;
}
