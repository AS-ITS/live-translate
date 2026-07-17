export const TRANSLATION_REPOSITORY_METHODS = Object.freeze([
  'createTranslationRequest',
  'getTranslationRequest',
  'findRequestById',
  'updateTranslationRequest',
  'listTranslationRequestsBySession',
  'createTranslationExecution',
  'getTranslationExecution',
  'findExecutionById',
  'updateTranslationExecution',
  'listTranslationExecutionsByRequest',
  'createTranslationOutput',
  'listTranslationOutputsByExecution',
  'listTranslationOutputsBySession',
  'listTranslationOutputsByRequest',
  'getTranslationOutput'
]);

export function createTranslationRepository() {
  return Object.freeze(
    Object.fromEntries(TRANSLATION_REPOSITORY_METHODS.map((method) => [method, createNotImplementedMethod(method)]))
  );
}

function createNotImplementedMethod(method) {
  return function translationRepositoryMethod() {
    throw new Error(`TranslationRepository.${method} is not implemented.`);
  };
}
