import { createTranslationProviderRegistry } from './translationProviderRegistry.js';
import { createTranslationProviderResolver } from './translationProviderResolver.js';

export function createTranslationProviderResolutionComposition({
  providers,
  configuration,
  resolverFactory = createTranslationProviderResolver
}) {
  const registry = createTranslationProviderRegistry({
    providers
  });

  const resolver = resolverFactory({
    registry,
    configuration
  });

  function resolve({ providerKey } = {}) {
    const resolveOptions = Object.create({
      configuration
    });
    resolveOptions.providerKey = providerKey;

    return resolver.resolve(resolveOptions);
  }

  return Object.freeze({
    registry,
    resolver,
    resolve
  });
}
