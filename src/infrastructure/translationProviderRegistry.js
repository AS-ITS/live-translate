export function createTranslationProviderRegistry(input) {
  assertFactoryInput(arguments.length, input);

  const { providers } = input;
  assertPlainObject(providers, 'providers must be a plain object.');

  const registeredProviders = new Map();

  for (const providerKey of Reflect.ownKeys(providers)) {
    assertProviderKey(providerKey);
    const provider = providers[providerKey];
    assertProvider(provider, providerKey);
    registeredProviders.set(providerKey, provider);
  }

  function get(providerKey) {
    assertProviderKey(providerKey);

    if (!registeredProviders.has(providerKey)) {
      throw new Error(`translation provider not found: ${providerKey}`);
    }

    return registeredProviders.get(providerKey);
  }

  function has(providerKey) {
    assertProviderKey(providerKey);
    return registeredProviders.has(providerKey);
  }

  function list() {
    return Object.freeze([...registeredProviders.keys()]);
  }

  return Object.freeze({
    get,
    has,
    list
  });
}

function assertFactoryInput(argumentCount, input) {
  if (argumentCount === 0 || input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('factory input must be an object with providers.');
  }

  if (!Object.hasOwn(input, 'providers')) {
    throw new TypeError('providers is required.');
  }
}

function assertPlainObject(value, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(message);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(message);
  }
}

function assertProviderKey(providerKey) {
  if (typeof providerKey !== 'string') {
    throw new TypeError('provider key must be a string.');
  }

  if (providerKey.trim().length === 0) {
    throw new TypeError('provider key must be a non-empty string.');
  }

  if (providerKey !== providerKey.trim()) {
    throw new TypeError(`provider key must not include surrounding whitespace: ${providerKey}`);
  }
}

function assertProvider(provider, providerKey) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new TypeError(`translation provider must be an object: ${providerKey}`);
  }

  if (typeof provider.translate !== 'function') {
    throw new TypeError(`translation provider translate must be a function: ${providerKey}`);
  }
}
