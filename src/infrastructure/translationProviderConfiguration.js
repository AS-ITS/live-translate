export const DEFAULT_TRANSLATION_PROVIDER = 'gemini';

export function createTranslationProviderConfiguration(input) {
  assertFactoryInput(arguments.length, input);

  const { environment } = input;
  assertEnvironment(environment);

  const defaultProviderKey = readDefaultProviderKey(environment);

  return Object.freeze({
    defaultProviderKey
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

function readDefaultProviderKey(environment) {
  const value = environment.TRANSLATION_PROVIDER;

  if (value === undefined) {
    return DEFAULT_TRANSLATION_PROVIDER;
  }

  if (typeof value !== 'string') {
    throw new TypeError('TRANSLATION_PROVIDER must be a string.');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TypeError('TRANSLATION_PROVIDER must be a non-empty string.');
  }

  return value;
}
