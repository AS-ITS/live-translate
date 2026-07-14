import { createSessionQueryService } from '../src/application/sessionQueryService.js';
import { createTranslationCommandService as createDefaultTranslationCommandService } from '../src/application/translationCommandService.js';
import { createTranslationRepositoryAdapter } from '../src/infrastructure/translationRepositoryAdapter.js';
import { createMemorySessionRepository } from '../src/lib/sessionRepository.js';
import { createSessionReadRepository } from '../src/repositories/sessionReadRepository.js';
import { createSessionReadController } from './sessionReadController.js';
import { createTranslationCommandController as createDefaultTranslationCommandController } from './translationCommandController.js';

export function createApplicationDependencies(options = {}) {
  const {
    requestHandlerFactory,
    translationRepository,
    translationCommandServiceFactory = createDefaultTranslationCommandService,
    translationCommandControllerFactory = createDefaultTranslationCommandController,
    ...sessionReadOptions
  } = options;
  const sessionReadDependencies = createSessionReadDependencies(sessionReadOptions);
  const translationCommandDependencies = createTranslationCommandDependencies({
    translationRepository: Object.prototype.hasOwnProperty.call(options, 'translationRepository')
      ? translationRepository
      : createTranslationRepositoryAdapter({ sessionRepository: sessionReadDependencies.sessionRepository }),
    translationCommandServiceFactory,
    translationCommandControllerFactory
  });
  const requestHandler = requestHandlerFactory
    ? requestHandlerFactory({
        sessionReadController: sessionReadDependencies.sessionReadController,
        translationCommandController: translationCommandDependencies.translationCommandController
      })
    : undefined;

  return {
    ...sessionReadDependencies,
    ...translationCommandDependencies,
    ...(requestHandler ? { requestHandler } : {})
  };
}

export function createSessionReadDependencies({ sessionRepository, sessionReadRepository } = {}) {
  const resolvedSessionRepository = sessionRepository || createMemorySessionRepository();
  const resolvedSessionReadRepository =
    sessionReadRepository || createSessionReadRepository({ sessionRepository: resolvedSessionRepository });
  const sessionQueryService = createSessionQueryService({
    sessionReadRepository: resolvedSessionReadRepository
  });
  const sessionReadController = createSessionReadController({
    sessionQueryService
  });

  return {
    sessionRepository: resolvedSessionRepository,
    sessionReadRepository: resolvedSessionReadRepository,
    sessionQueryService,
    sessionReadController
  };
}

export function createTranslationCommandDependencies({
  translationRepository,
  translationCommandServiceFactory = createDefaultTranslationCommandService,
  translationCommandControllerFactory = createDefaultTranslationCommandController
} = {}) {
  assertFactory(translationCommandServiceFactory, 'translationCommandServiceFactory');
  assertFactory(translationCommandControllerFactory, 'translationCommandControllerFactory');

  const translationCommandService = translationCommandServiceFactory({
    translationRepository
  });
  const translationCommandController = translationCommandControllerFactory({
    translationCommandService
  });

  return {
    translationRepository,
    translationCommandService,
    translationCommandController
  };
}

function assertFactory(factory, name) {
  if (typeof factory !== 'function') {
    throw new TypeError(`${name} must be a function.`);
  }
}
