export class ProductionTranslationExecutionProvider {
  #implementation;

  constructor(implementation) {
    assertProviderImplementation(implementation);

    this.#implementation = implementation;
    Object.freeze(this);
  }

  async execute(input) {
    return await this.#implementation.execute(input);
  }
}

function assertProviderImplementation(implementation) {
  if (!implementation || typeof implementation !== 'object') {
    throw new TypeError('productionTranslationExecutionProvider implementation is required.');
  }

  if (typeof implementation.execute !== 'function') {
    throw new TypeError('productionTranslationExecutionProvider.execute must be a function.');
  }
}
