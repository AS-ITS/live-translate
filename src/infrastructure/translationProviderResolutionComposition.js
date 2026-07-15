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

  return Object.freeze({
    registry,
    resolver
  });
}
