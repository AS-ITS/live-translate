import { createSessionQueryService } from '../src/application/sessionQueryService.js';
import { createMemorySessionRepository } from '../src/lib/sessionRepository.js';
import { createSessionReadRepository } from '../src/repositories/sessionReadRepository.js';
import { createSessionReadController } from './sessionReadController.js';

export function createApplicationDependencies(options = {}) {
  return createSessionReadDependencies(options);
}

export function createSessionReadDependencies({ sessionRepository, sessionReadRepository } = {}) {
  const resolvedSessionRepository = sessionRepository || (sessionReadRepository ? null : createMemorySessionRepository());
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
