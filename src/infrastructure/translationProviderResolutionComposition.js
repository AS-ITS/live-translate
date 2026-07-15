import { createTranslationProviderRegistry } from './translationProviderRegistry.js';
import { createTranslationProviderResolver } from './translationProviderResolver.js';

export function createTranslationProviderResolutionComposition({
  providers,
  defaultProviderKey
}) {
  const registry = createTranslationProviderRegistry({
    providers
  });

  const resolver = createTranslationProviderResolver({
    registry,
    configuration: {
      defaultProviderKey
    }
  });

  if (!registry.has(defaultProviderKey)) {
    throw new Error(`defaultProviderKey is not registered: ${defaultProviderKey}`);
  }

  return Object.freeze({
    registry,
    resolver
  });
}
