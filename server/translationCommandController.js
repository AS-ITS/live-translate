const TRANSLATION_COMMAND_SERVICE_METHODS = Object.freeze([
  'createTranslationRequest',
  'createTranslationExecution',
  'updateTranslationExecution',
  'createTranslationOutput'
]);

export function createTranslationCommandController({ translationCommandService } = {}) {
  assertTranslationCommandService(translationCommandService);

  return Object.freeze({
    createTranslationRequest(input) {
      return translationCommandService.createTranslationRequest(input);
    },

    createTranslationExecution(input) {
      return translationCommandService.createTranslationExecution(forwardTranslationExecutionInput(input));
    },

    updateTranslationExecution(input) {
      return translationCommandService.updateTranslationExecution(input);
    },

    createTranslationOutput(input) {
      return translationCommandService.createTranslationOutput(input);
    }
  });
}

function forwardTranslationExecutionInput(input) {
  return input;
}

function assertTranslationCommandService(translationCommandService) {
  if (!translationCommandService) {
    throw new TypeError('translationCommandService is required.');
  }

  for (const methodName of TRANSLATION_COMMAND_SERVICE_METHODS) {
    assertMethod(translationCommandService, methodName);
  }
}

function assertMethod(target, methodName) {
  if (typeof target[methodName] !== 'function') {
    throw new TypeError(`translationCommandService.${methodName} must be a function.`);
  }
}
