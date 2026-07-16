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

const EXECUTION_TRANSITIONS = Object.freeze(['start', 'complete', 'fail', 'cancel']);
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
  translationExecutionProvider
} = {}) {
  const resolvedTranslationRepository = translationRepository ?? repository;

  assertTranslationRepository(resolvedTranslationRepository);
  assertDomainEventPublisher(domainEventPublisher);
  assertTranslationExecutionDispatcher(translationExecutionDispatcher);
  assertOptionalTranslationExecutionProvider(translationExecutionProvider);

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

      if (translationExecutionProvider) {
        return executeTranslationAndPublishAfterRepositoryResult(
          repositoryResult,
          execution,
          payload,
          resolvedTranslationRepository,
          domainEventPublisher,
          translationExecutionProvider
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

function assertOptionalTranslationExecutionProvider(translationExecutionProvider) {
  if (translationExecutionProvider === undefined) {
    return;
  }

  if (!translationExecutionProvider || typeof translationExecutionProvider !== 'object') {
    throw new TypeError('translationExecutionProvider must be an object.');
  }

  if (typeof translationExecutionProvider.execute !== 'function') {
    throw new TypeError('translationExecutionProvider.execute must be a function.');
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
    case 'start':
      return execution.start(payload.startedAt);
    case 'complete':
      return execution.complete(payload.completedAt);
    case 'fail':
      return execution.fail(payload.failureInfo, payload.completedAt);
    case 'cancel':
      return execution.cancel(payload.completedAt);
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
  translationRepository,
  domainEventPublisher,
  translationExecutionProvider
) {
  if (isPromiseLike(repositoryResult)) {
    return repositoryResult.then((resolvedRepositoryResult) =>
      executeTranslationPublishEventsAndReturnResult(
        translationRepository,
        execution,
        payload,
        domainEventPublisher,
        translationExecutionProvider,
        resolvedRepositoryResult
      )
    );
  }

  return executeTranslationPublishEventsAndReturnResult(
    translationRepository,
    execution,
    payload,
    domainEventPublisher,
    translationExecutionProvider,
    repositoryResult
  );
}

async function executeTranslationPublishEventsAndReturnResult(
  translationRepository,
  execution,
  payload,
  domainEventPublisher,
  translationExecutionProvider,
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

  const providerResult = await translationExecutionProvider.execute({
    sourceText: payload.sourceText,
    sourceLanguageCode: payload.sourceLanguageCode,
    targetLanguageCode: payload.targetLanguageCode,
    providerKey: payload.providerKey
  });

  const output = new TranslationOutput({
    id: payload.outputId ?? `${execution.id}-output-0`,
    executionId: execution.id,
    sequence: payload.outputSequence ?? 0,
    translatedText: providerResult.translatedText,
    targetLanguageCode: payload.targetLanguageCode,
    createdAt: payload.outputCreatedAt ?? payload.completedAt ?? execution.startedAt
  });
  const outputRepositoryResult = translationRepository.createTranslationOutput(output);
  await publishAfterRepositoryResult(
    outputRepositoryResult,
    () =>
      createTranslationOutputCreatedEvent({
        occurredAt: output.createdAt,
        output
      }),
    domainEventPublisher
  );

  const completedExecution = new TranslationExecution({
    id: execution.id,
    translationRequestId: execution.translationRequestId,
    status: 'completed',
    providerKey: execution.providerKey,
    startedAt: execution.startedAt,
    completedAt: payload.completedAt ?? execution.startedAt
  });
  const completedRepositoryResult = translationRepository.updateTranslationExecution(completedExecution);

  await publishAfterRepositoryResult(
    completedRepositoryResult,
    () =>
      createTranslationExecutionUpdatedEvent({
        occurredAt: completedExecution.completedAt,
        execution: completedExecution
      }),
    domainEventPublisher
  );

  return repositoryResult;
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
    case 'start':
      return execution.startedAt;
    case 'complete':
    case 'fail':
    case 'cancel':
      return execution.completedAt;
    default:
      throw new TypeError(`Unsupported TranslationExecution transition: ${transition}`);
  }
}
