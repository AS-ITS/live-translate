import {
  TranslationExecution,
  TranslationOutput,
  TranslationRequest,
  createTranslationExecutionCreatedEvent,
  createTranslationExecutionUpdatedEvent,
  createTranslationOutputCreatedEvent,
  createTranslationRequestCreatedEvent
} from '../domain/translation/index.js';
import { assertTranslationExecutionQueue } from './translation/translationExecutionQueue.js';

const EXECUTION_TRANSITIONS = Object.freeze(['queue', 'start', 'complete', 'fail']);
const TRANSLATION_COMMAND_REPOSITORY_METHODS = Object.freeze([
  'createTranslationRequest',
  'getTranslationRequest',
  'updateTranslationRequest',
  'listTranslationRequestsBySession',
  'createTranslationExecution',
  'getTranslationExecution',
  'updateTranslationExecution',
  'listTranslationExecutionsByRequest',
  'createTranslationOutput',
  'listTranslationOutputsByExecution',
  'listTranslationOutputsBySession',
  'listTranslationOutputsByRequest',
  'getTranslationOutput'
]);
const DEFAULT_TRANSLATION_EXECUTION_DISPATCHER = Object.freeze({
  async dispatch() {
    return undefined;
  }
});
const DEFAULT_TRANSLATION_EXECUTION_QUEUE = Object.freeze({
  enqueue() {
    return undefined;
  },
  dequeue() {
    return null;
  },
  size() {
    return 0;
  }
});

export function createTranslationCommandService({
  translationRepository,
  repository,
  domainEventPublisher,
  translationExecutionDispatcher = DEFAULT_TRANSLATION_EXECUTION_DISPATCHER,
  translationExecutionQueue = DEFAULT_TRANSLATION_EXECUTION_QUEUE,
  translationExecutionProviderResolver,
  translationExecutionRunner,
  retryPolicy
} = {}) {
  const resolvedTranslationRepository = translationRepository ?? repository;

  assertTranslationRepository(resolvedTranslationRepository);
  assertDomainEventPublisher(domainEventPublisher);
  assertTranslationExecutionDispatcher(translationExecutionDispatcher);
  assertTranslationExecutionQueue(translationExecutionQueue);

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

      return enqueueExecutionAndPublishAfterRepositoryResult(
        repositoryResult,
        execution,
        () =>
          createTranslationExecutionCreatedEvent({
            occurredAt: execution.startedAt,
            execution
          }),
        domainEventPublisher,
        resolvedTranslationRepository,
        translationExecutionQueue
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

  for (const methodName of TRANSLATION_COMMAND_REPOSITORY_METHODS) {
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

function enqueueExecutionAndPublishAfterRepositoryResult(
  repositoryResult,
  execution,
  createEvent,
  domainEventPublisher,
  translationRepository,
  translationExecutionQueue
) {
  if (isPromiseLike(repositoryResult)) {
    return repositoryResult.then((resolvedRepositoryResult) =>
      enqueueExecutionPublishEventsAndReturnResult(
        execution,
        createEvent,
        domainEventPublisher,
        translationRepository,
        translationExecutionQueue,
        resolvedRepositoryResult
      )
    );
  }

  return enqueueExecutionPublishEventsAndReturnResult(
    execution,
    createEvent,
    domainEventPublisher,
    translationRepository,
    translationExecutionQueue,
    repositoryResult
  );
}

async function enqueueExecutionPublishEventsAndReturnResult(
  execution,
  createEvent,
  domainEventPublisher,
  translationRepository,
  translationExecutionQueue,
  repositoryResult
) {
  await publishEventAndReturnResult(domainEventPublisher, createEvent(), repositoryResult);

  const queuedExecution = execution.queue();
  const queuedRepositoryResult = await translationRepository.updateTranslationExecution(queuedExecution);
  await publishTranslationExecutionUpdatedEvent(domainEventPublisher, queuedExecution, queuedRepositoryResult);
  await translationExecutionQueue.enqueue({
    executionId: queuedExecution.id,
    requestId: queuedExecution.translationRequestId
  });

  return queuedExecution;
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
