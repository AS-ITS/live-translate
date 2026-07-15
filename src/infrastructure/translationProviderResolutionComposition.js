import { createTranslationProviderRegistry } from './translationProviderRegistry.js';
import { createTranslationProviderResolver } from './translationProviderResolver.js';

export function createTranslationProviderResolutionComposition({
  providers,
  configuration
}) {
  const registry = createTranslationProviderRegistry({
    providers
  });

  const resolver = createTranslationProviderResolver({
    registry,
    configuration
  });

  if (!registry.has(configuration.defaultProviderKey)) {
    throw new Error(`defaultProviderKey is not registered: ${configuration.defaultProviderKey}`);
  }

  return Object.freeze({
    registry,
    resolver
  });
}
