export function createTranslationProviderResolver(input) {
  assertFactoryInput(arguments.length, input);

  const { registry, defaultProviderKey } = input;
  assertRegistry(registry);
  assertProviderKey(defaultProviderKey, 'defaultProviderKey');

  if (!registry.has(defaultProviderKey)) {
    throw new Error(`defaultProviderKey is not registered: ${defaultProviderKey}`);
  }

  function resolve(options) {
    assertResolveOptions(arguments.length, options);

    const selectedProviderKey =
      arguments.length === 0 || !Object.hasOwn(options, 'providerKey') || options.providerKey === undefined
        ? defaultProviderKey
        : options.providerKey;

    assertProviderKey(selectedProviderKey, 'providerKey');

    return registry.get(selectedProviderKey);
  }

  return Object.freeze({
    resolve
  });
}

function assertFactoryInput(argumentCount, input) {
  if (argumentCount === 0 || input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('factory input must be an object with registry and defaultProviderKey.');
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

function assertProviderKey(providerKey, optionName) {
  if (typeof providerKey !== 'string') {
    throw new TypeError(`${optionName} must be a string.`);
  }

  if (providerKey.trim().length === 0) {
    throw new TypeError(`${optionName} must be a non-empty string.`);
  }

  if (providerKey !== providerKey.trim()) {
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
