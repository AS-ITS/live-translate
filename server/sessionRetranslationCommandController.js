export function createSessionRetranslationCommandController({ sessionRetranslationCommandService } = {}) {
  if (!sessionRetranslationCommandService || typeof sessionRetranslationCommandService.submitRetranslation !== 'function') {
    throw new TypeError('sessionRetranslationCommandService.submitRetranslation must be a function.');
  }
  return Object.freeze({
    submitRetranslation(input) { return sessionRetranslationCommandService.submitRetranslation(input); }
  });
}
