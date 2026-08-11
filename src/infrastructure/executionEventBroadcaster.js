import { safeFailureInfo } from '../readModels/translationReadModels.js';

export function createExecutionEventBroadcaster() {
  const sessions = new Map();

  return Object.freeze({
    publish(sessionId, execution) {
      const state = stateFor(sessionId);
      state.sequence += 1;
      const event = {
        type: 'execution.snapshot',
        sequence: state.sequence,
        sessionId,
        execution: executionSnapshot(execution)
      };
      for (const listener of [...state.listeners]) listener(event);
      return event;
    },

    subscribe(sessionId, listener) {
      const state = stateFor(sessionId);
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
        if (state.listeners.size === 0 && state.sequence === 0) sessions.delete(sessionId);
      };
    }
  });

  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { sequence: 0, listeners: new Set() };
      sessions.set(sessionId, state);
    }
    return state;
  }
}

export function createExecutionEventRepository({ repository, broadcaster } = {}) {
  if (!repository || typeof repository !== 'object') throw new TypeError('repository is required.');
  if (!broadcaster || typeof broadcaster.publish !== 'function') throw new TypeError('broadcaster.publish is required.');
  if (Object.isFrozen(repository)) return repository;

  const createTranslationExecution = repository.createTranslationExecution.bind(repository);
  const updateTranslationExecution = repository.updateTranslationExecution.bind(repository);
  repository.createTranslationExecution = (...args) => publishAfter(repository, createTranslationExecution(...args));
  repository.updateTranslationExecution = (...args) => publishAfter(repository, updateTranslationExecution(...args));
  return repository;

  function publishAfter(target, result) {
    if (result && typeof result.then === 'function') return result.then((execution) => publishResolved(target, execution));
    return publishResolved(target, result);
  }

  function publishResolved(target, execution) {
    if (!execution) return execution;
    const request = target.findRequestById(execution.translationRequestId);
    if (request && typeof request.then === 'function') return request.then((resolvedRequest) => publishSnapshot(resolvedRequest, execution));
    return publishSnapshot(request, execution);
  }

  function publishSnapshot(request, execution) {
    if (request?.sessionId) broadcaster.publish(request.sessionId, {
      id: execution.id,
      requestId: request.id,
      translationRequestId: request.id,
      status: execution.status,
      targetLanguageCode: request.targetLanguageCode,
      startedAt: execution.startedAt ?? null,
      createdAt: request.createdAt ?? null,
      providerAttemptStatus: execution.providerAttemptStatus ?? 'not_started',
      providerAttemptedAt: execution.providerAttemptedAt ?? null,
      providerCompletedAt: execution.providerCompletedAt ?? null,
      completedAt: execution.completedAt ?? null,
      failureInfo: safeFailureInfo(execution.failureInfo)
    });
    return execution;
  }
}

export function executionSnapshot(execution = {}) {
  return {
    id: execution.id,
    requestId: execution.requestId,
    translationRequestId: execution.translationRequestId,
    status: execution.status,
    targetLanguageCode: execution.targetLanguageCode,
    startedAt: execution.startedAt ?? null,
    createdAt: execution.createdAt ?? null,
    providerAttemptStatus: execution.providerAttemptStatus ?? 'not_started',
    providerAttemptedAt: execution.providerAttemptedAt ?? null,
    providerCompletedAt: execution.providerCompletedAt ?? null,
    completedAt: execution.completedAt ?? null,
    failureInfo: safeFailureInfo(execution.failureInfo)
  };
}
