const SERVICE_METHODS = Object.freeze(['translateSavedTranscript']);

export function createSavedTranscriptRetranslationController({ savedTranscriptRetranslationService } = {}) {
  assertSavedTranscriptRetranslationService(savedTranscriptRetranslationService);

  return Object.freeze({
    translateSavedTranscript(input) {
      return savedTranscriptRetranslationService.translateSavedTranscript(input);
    }
  });
}

function assertSavedTranscriptRetranslationService(savedTranscriptRetranslationService) {
  if (!savedTranscriptRetranslationService || typeof savedTranscriptRetranslationService !== 'object') {
    throw new TypeError('savedTranscriptRetranslationService is required.');
  }

  for (const methodName of SERVICE_METHODS) {
    if (typeof savedTranscriptRetranslationService[methodName] !== 'function') {
      throw new TypeError(`savedTranscriptRetranslationService.${methodName} must be a function.`);
    }
  }
}
