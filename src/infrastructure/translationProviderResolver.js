export function createTranslationProviderResolver(input) {
  assertFactoryInput(arguments.length, input);

  const { registry, configuration } = input;
  assertRegistry(registry);
  assertConfiguration(configuration);
  const { defaultProviderKey } = configuration;
  assertProviderKey(defaultProviderKey, 'configuration.defaultProviderKey');

  function resolve(options) {
    assertResolveOptions(arguments.length, options);

    const selectedProviderKey =
      arguments.length === 0 || !Object.hasOwn(options, 'providerKey') || options.providerKey === undefined
        ? defaultProviderKey
        : options.providerKey;

    assertProviderKey(selectedProviderKey, 'providerKey', {
      rejectSurroundingWhitespace: false
    });

    return registry.get(selectedProviderKey);
  }

  return Object.freeze({
    resolve
  });
}

function assertFactoryInput(argumentCount, input) {
  if (argumentCount === 0 || input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('factory input must be an object with registry and configuration.');
  }

  for (const optionName of Reflect.ownKeys(input)) {
    if (optionName !== 'registry' && optionName !== 'configuration') {
      throw new TypeError(`unsupported factory option: ${String(optionName)}`);
    }
  }
}

function assertRegistry(registry) {
  if (registry === null || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new TypeError('registry must be an object with get and has functions.');
  }

  if (typeof registry.get !== 'function') {
    throw new TypeError('registry.get must be a function.');
  }

  if (typeof registry.has !== 'function') {
    throw new TypeError('registry.has must be a function.');
  }
}

function assertConfiguration(configuration) {
  if (configuration === null || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new TypeError('configuration must be an object with defaultProviderKey.');
  }

  if (!Object.hasOwn(configuration, 'defaultProviderKey')) {
    throw new TypeError('configuration.defaultProviderKey is required.');
  }
}

function assertProviderKey(providerKey, optionName, { rejectSurroundingWhitespace = true } = {}) {
  if (typeof providerKey !== 'string') {
    throw new TypeError(`${optionName} must be a string.`);
  }

  if (providerKey.trim().length === 0) {
    throw new TypeError(`${optionName} must be a non-empty string.`);
  }

  if (rejectSurroundingWhitespace && providerKey !== providerKey.trim()) {
    throw new TypeError(`${optionName} must not include surrounding whitespace: ${providerKey}`);
  }
}

function assertResolveOptions(argumentCount, options) {
  if (argumentCount === 0) {
    return;
  }

  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('resolve options must be an object.');
  }

  for (const optionName of Reflect.ownKeys(options)) {
    if (optionName !== 'providerKey') {
      throw new TypeError(`unsupported resolve option: ${String(optionName)}`);
    }
  }
}
