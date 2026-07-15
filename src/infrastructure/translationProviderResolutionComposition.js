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
    defaultProviderKey
  });

  return Object.freeze({
    registry,
    resolver
  });
}
