import {
  TranslationExecution,
  TranslationOutput,
  TranslationRequest,
  createTranslationExecutionCreatedEvent,
  createTranslationExecutionUpdatedEvent,
  createTranslationOutputCreatedEvent,
  createTranslationRequestCreatedEvent
} from '../domain/translation/index.js';
import { TRANSLATION_REPOSITORY_METHODS } from '../domain/translation/translationRepository.js';
import { createTranslationExecutionRunner } from './translationExecutionRunner.js';

const EXECUTION_TRANSITIONS = Object.freeze(['queue', 'start', 'complete', 'fail']);
const DEFAULT_TRANSLATION_EXECUTION_DISPATCHER = Object.freeze({
  async dispatch() {
    return undefined;
  }
});

export function createTranslationCommandService({
  translationRepository,
  repository,
  domainEventPublisher,
  translationExecutionDispatcher = DEFAULT_TRANSLATION_EXECUTION_DISPATCHER,
  translationExecutionProviderResolver,
  translationExecutionRunner,
  retryPolicy
} = {}) {
  const resolvedTranslationRepository = translationRepository ?? repository;

  assertTranslationRepository(resolvedTranslationRepository);
  assertDomainEventPublisher(domainEventPublisher);
  assertTranslationExecutionDispatcher(translationExecutionDispatcher);

  const resolvedTranslationExecutionRunner =
    translationExecutionRunner ??
    (translationExecutionProviderResolver
      ? createTranslationExecutionRunner({
          translationRepository: resolvedTranslationRepository,
          translationExecutionProvider: createResolverBackedTranslationExecutionProvider(
            translationExecutionProviderResolver
          ),
          retryPolicy
        })
      : undefined);

  assertOptionalTranslationExecutionRunner(resolvedTranslationExecutionRunner);

  return Object.freeze({
    createTranslationRequest(payload) {
      const request = new TranslationRequest(payload);
      const repositoryResult = resolvedTranslationRepository.createTranslationRequest(request);

      return publishAfterRepositoryResult(
        repositoryResult,
        () =>
          createTranslationRequestCreatedEvent({
            occurredAt: request.createdAt,
            request
          }),
        domainEventPublisher
      );
    },

    createTranslationExecution(payload) {
      const execution = createTranslationExecutionDomainObject(payload);
      const repositoryResult = resolvedTranslationRepository.createTranslationExecution(execution);

      if (resolvedTranslationExecutionRunner) {
        return executeTranslationAndPublishAfterRepositoryResult(
          repositoryResult,
          execution,
          payload,
          domainEventPublisher,
          resolvedTranslationExecutionRunner,
          resolvedTranslationRepository
        );
      }

      return dispatchExecutionAndPublishAfterRepositoryResult(
        repositoryResult,
        execution,
        () =>
          createTranslationExecutionCreatedEvent({
            occurredAt: execution.startedAt,
            execution
          }),
        domainEventPublisher,
        translationExecutionDispatcher
      );
    },

    updateTranslationExecution(payload = {}) {
      const { executionId, transition, ...transitionPayload } = payload;
      const result = resolvedTranslationRepository.getTranslationExecution(executionId);

      if (isPromiseLike(result)) {
        return result.then((execution) =>
          updateExecution(
            resolvedTranslationRepository,
            domainEventPublisher,
            executionId,
            execution,
            transition,
            transitionPayload
          )
        );
      }

      return updateExecution(
        resolvedTranslationRepository,
        domainEventPublisher,
        executionId,
        result,
        transition,
        transitionPayload
      );
    },

    createTranslationOutput(payload) {
      const output = new TranslationOutput(payload);
      const repositoryResult = resolvedTranslationRepository.createTranslationOutput(output);

      return publishAfterRepositoryResult(
        repositoryResult,
        () =>
          createTranslationOutputCreatedEvent({
            occurredAt: output.createdAt,
            output
          }),
        domainEventPublisher
      );
    }
  });
}

function createTranslationExecutionDomainObject(payload) {
  return new TranslationExecution(payload);
}

function assertTranslationRepository(translationRepository) {
  if (!translationRepository) {
    throw new TypeError('translationRepository is required.');
  }

  for (const methodName of TRANSLATION_REPOSITORY_METHODS) {
    assertMethod(translationRepository, methodName);
  }
}

function assertMethod(target, methodName) {
  if (typeof target[methodName] !== 'function') {
    throw new TypeError(`translationRepository.${methodName} must be a function.`);
  }
}

function assertDomainEventPublisher(domainEventPublisher) {
  if (!domainEventPublisher || typeof domainEventPublisher !== 'object') {
    throw new TypeError('domainEventPublisher is required.');
  }

  if (typeof domainEventPublisher.publish !== 'function') {
    throw new TypeError('domainEventPublisher.publish must be a function.');
  }
}

function assertTranslationExecutionDispatcher(translationExecutionDispatcher) {
  if (!translationExecutionDispatcher || typeof translationExecutionDispatcher !== 'object') {
    throw new TypeError('translationExecutionDispatcher is required.');
  }

  if (typeof translationExecutionDispatcher.dispatch !== 'function') {
    throw new TypeError('translationExecutionDispatcher.dispatch must be a function.');
  }
}

function assertOptionalTranslationExecutionRunner(translationExecutionRunner) {
  if (translationExecutionRunner === undefined) {
    return;
  }

  if (!translationExecutionRunner || typeof translationExecutionRunner !== 'object') {
    throw new TypeError('translationExecutionRunner must be an object.');
  }

  if (typeof translationExecutionRunner.execute !== 'function') {
    throw new TypeError('translationExecutionRunner.execute must be a function.');
  }
}

function createResolverBackedTranslationExecutionProvider(translationExecutionProviderResolver) {
  assertTranslationExecutionProviderResolver(translationExecutionProviderResolver);

  return Object.freeze({
    async execute(input) {
      const provider = await translationExecutionProviderResolver.resolve(input.providerKey);
      assertTranslationExecutionProvider(provider);

      return provider.execute(input);
    }
  });
}

function assertTranslationExecutionProviderResolver(translationExecutionProviderResolver) {
  if (!translationExecutionProviderResolver || typeof translationExecutionProviderResolver !== 'object') {
    throw new TypeError('translationExecutionProviderResolver is required.');
  }

  if (typeof translationExecutionProviderResolver.resolve !== 'function') {
    throw new TypeError('translationExecutionProviderResolver.resolve must be a function.');
  }
}

function assertTranslationExecutionProvider(translationExecutionProvider) {
  if (!translationExecutionProvider || typeof translationExecutionProvider !== 'object') {
    throw new TypeError('resolved translationExecutionProvider is required.');
  }

  if (typeof translationExecutionProvider.execute !== 'function') {
    throw new TypeError('resolved translationExecutionProvider.execute must be a function.');
  }
}

function updateExecution(translationRepository, domainEventPublisher, executionId, execution, transition, transitionPayload) {
  if (execution === null || execution === undefined) {
    throw new Error(`TranslationExecution ${executionId} was not found`);
  }

  const updatedExecution = applyExecutionTransition(execution, transition, transitionPayload);
  const repositoryResult = translationRepository.updateTranslationExecution(updatedExecution);

  return publishAfterRepositoryResult(
    repositoryResult,
    () =>
      createTranslationExecutionUpdatedEvent({
        occurredAt: executionTransitionOccurredAt(transition, updatedExecution),
        execution: updatedExecution
      }),
    domainEventPublisher
  );
}

function applyExecutionTransition(execution, transition, payload) {
  if (!EXECUTION_TRANSITIONS.includes(transition) || typeof execution[transition] !== 'function') {
    throw new TypeError(`Unsupported TranslationExecution transition: ${transition}`);
  }

  switch (transition) {
    case 'queue':
      return execution.queue();
    case 'start':
      return execution.start(payload.startedAt);
    case 'complete':
      return execution.complete(payload.completedAt);
    case 'fail':
      return execution.fail(payload.failureInfo, payload.completedAt);
    default:
      throw new TypeError(`Unsupported TranslationExecution transition: ${transition}`);
  }
}

function isPromiseLike(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function';
}

function publishAfterRepositoryResult(repositoryResult, createEvent, domainEventPublisher) {
  if (isPromiseLike(repositoryResult)) {
    return repositoryResult.then((resolvedRepositoryResult) =>
      publishEventAndReturnResult(domainEventPublisher, createEvent(), resolvedRepositoryResult)
    );
  }

  return publishEventAndReturnResult(domainEventPublisher, createEvent(), repositoryResult);
}

function executeTranslationAndPublishAfterRepositoryResult(
  repositoryResult,
  execution,
  payload,
  domainEventPublisher,
  translationExecutionRunner,
  translationRepository
) {
  if (isPromiseLike(repositoryResult)) {
    return repositoryResult.then((resolvedRepositoryResult) =>
      executeTranslationPublishEventsAndReturnResult(
        execution,
        payload,
        domainEventPublisher,
        translationExecutionRunner,
        translationRepository,
        resolvedRepositoryResult
      )
    );
  }

  return executeTranslationPublishEventsAndReturnResult(
    execution,
    payload,
    domainEventPublisher,
    translationExecutionRunner,
    translationRepository,
    repositoryResult
  );
}

async function executeTranslationPublishEventsAndReturnResult(
  execution,
  payload,
  domainEventPublisher,
  translationExecutionRunner,
  translationRepository,
  repositoryResult
) {
  await publishEventAndReturnResult(
    domainEventPublisher,
    createTranslationExecutionCreatedEvent({
      occurredAt: execution.startedAt,
      execution
    }),
    repositoryResult
  );

  const queuedExecution = execution.queue();
  const queuedRepositoryResult = await translationRepository.updateTranslationExecution(queuedExecution);
  await publishTranslationExecutionUpdatedEvent(domainEventPublisher, queuedExecution, queuedRepositoryResult);

  const runningExecution = queuedExecution.start(payload.startedAt);
  const runningRepositoryResult = await translationRepository.updateTranslationExecution(runningExecution);
  await publishTranslationExecutionUpdatedEvent(domainEventPublisher, runningExecution, runningRepositoryResult);

  return translationExecutionRunner.execute({
    execution: runningExecution,
    payload,
    repositoryResult,
    onTranslationOutputCreated({ output, repositoryResult: outputRepositoryResult }) {
      return publishAfterRepositoryResult(
        outputRepositoryResult,
        () =>
          createTranslationOutputCreatedEvent({
            occurredAt: output.createdAt,
            output
          }),
        domainEventPublisher
      );
    },
    onTranslationExecutionUpdated({ execution: updatedExecution, repositoryResult: executionRepositoryResult }) {
      return publishTranslationExecutionUpdatedEvent(domainEventPublisher, updatedExecution, executionRepositoryResult);
    }
  });
}

function publishTranslationExecutionUpdatedEvent(domainEventPublisher, execution, repositoryResult) {
  return publishAfterRepositoryResult(
    repositoryResult,
    () =>
      createTranslationExecutionUpdatedEvent({
        occurredAt: executionUpdatedEventOccurredAt(execution),
        execution
      }),
    domainEventPublisher
  );
}

function dispatchExecutionAndPublishAfterRepositoryResult(
  repositoryResult,
  execution,
  createEvent,
  domainEventPublisher,
  translationExecutionDispatcher
) {
  if (isPromiseLike(repositoryResult)) {
    return repositoryResult.then((resolvedRepositoryResult) =>
      dispatchExecutionPublishEventAndReturnResult(
        translationExecutionDispatcher,
        execution,
        domainEventPublisher,
        createEvent,
        resolvedRepositoryResult
      )
    );
  }

  return dispatchExecutionPublishEventAndReturnResult(
    translationExecutionDispatcher,
    execution,
    domainEventPublisher,
    createEvent,
    repositoryResult
  );
}

async function dispatchExecutionPublishEventAndReturnResult(
  translationExecutionDispatcher,
  execution,
  domainEventPublisher,
  createEvent,
  repositoryResult
) {
  await translationExecutionDispatcher.dispatch(execution);

  return publishEventAndReturnResult(domainEventPublisher, createEvent(), repositoryResult);
}

function publishEventAndReturnResult(domainEventPublisher, event, repositoryResult) {
  const publicationResult = domainEventPublisher.publish(event);

  if (isPromiseLike(publicationResult)) {
    return publicationResult.then(() => repositoryResult);
  }

  return repositoryResult;
}

function executionTransitionOccurredAt(transition, execution) {
  switch (transition) {
    case 'queue':
    case 'start':
      return execution.startedAt;
    case 'complete':
    case 'fail':
      return execution.completedAt;
    default:
      throw new TypeError(`Unsupported TranslationExecution transition: ${transition}`);
  }
}

function executionUpdatedEventOccurredAt(execution) {
  if (execution.completedAt !== null) {
    return execution.completedAt;
  }

  return execution.startedAt;
}
