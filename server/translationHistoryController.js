export function createTranslationHistoryController({ translationHistoryQueryService } = {}) {
  if (!translationHistoryQueryService || typeof translationHistoryQueryService.listSessionTranslations !== 'function') throw new TypeError('translationHistoryQueryService.listSessionTranslations is required.');
  return Object.freeze({ listSessionTranslations(input) { return translationHistoryQueryService.listSessionTranslations(input); } });
}
