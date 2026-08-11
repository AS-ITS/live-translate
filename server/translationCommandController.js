const TRANSLATION_APPLICATION_SERVICE_METHODS = Object.freeze([
  'requestTranslation',
  'executeTranslation',
  'updateExecution',
  'recordTranslationOutput'
]);

export function createTranslationCommandController({ translationApplicationService, translationCommandService } = {}) {
  const service = translationApplicationService ?? createLegacyAdapter(translationCommandService);
  assertTranslationApplicationService(service);

  return Object.freeze({
    createTranslationRequest(input) {
      return service.requestTranslation(input);
    },

    createTranslationExecution(input) {
      return service.executeTranslation(forwardTranslationExecutionInput(input));
    },

    updateTranslationExecution(input) {
      return service.updateExecution(input);
    },

    createTranslationOutput(input) {
      return service.recordTranslationOutput(input);
    }
  });
}

function forwardTranslationExecutionInput(input) {
  return input;
}

function assertTranslationApplicationService(service) {
  if (!service) throw new TypeError('translationApplicationService is required.');
  for (const methodName of TRANSLATION_APPLICATION_SERVICE_METHODS) {
    if (typeof service[methodName] !== 'function') {
      throw new TypeError(`translationApplicationService.${methodName} must be a function.`);
    }
  }
}

function createLegacyAdapter(translationCommandService) {
  if (!translationCommandService) throw new TypeError('translationApplicationService is required.');
  for (const methodName of ['createTranslationRequest', 'createTranslationExecution', 'updateTranslationExecution', 'createTranslationOutput']) {
    if (typeof translationCommandService[methodName] !== 'function') {
      throw new TypeError(`translationCommandService.${methodName} must be a function.`);
    }
  }
  return {
    requestTranslation: (input) => translationCommandService.createTranslationRequest(input),
    executeTranslation: (input) => translationCommandService.createTranslationExecution(input),
    updateExecution: (input) => translationCommandService.updateTranslationExecution(input),
    recordTranslationOutput: (input) => translationCommandService.createTranslationOutput(input)
  };
}
