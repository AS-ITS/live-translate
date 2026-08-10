export function createTranslationHistoryController({ translationApplicationService, translationHistoryQueryService } = {}) {
  const service = translationApplicationService ?? translationHistoryQueryService;
  if (!service || typeof service.listSessionTranslations !== 'function') throw new TypeError('translationApplicationService.listSessionTranslations is required.');
  return Object.freeze({ listSessionTranslations(input) { return service.listSessionTranslations(input); } });
}
