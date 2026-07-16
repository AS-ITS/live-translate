export function createFakeTranslationExecutionProvider() {
  return Object.freeze({
    async execute(input) {
      return Object.freeze({
        translatedText: `[fake] ${input.sourceText}`,
        detectedSourceLanguageCode: input.sourceLanguageCode ?? undefined
      });
    }
  });
}
