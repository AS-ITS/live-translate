export function createSavedTranscriptTranslationProvider() {
  return Object.freeze({
    translate(input) {
      void input;
      throw new Error('Saved transcript translation provider is not implemented');
    }
  });
}
