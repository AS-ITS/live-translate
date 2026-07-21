import { assertTranslationExecutionQueue } from './translationExecutionQueue.js';
import { randomUUID } from 'node:crypto';
import {
  assertDurableTranslationExecutionQueueRepository,
  compareDurableTranslationExecutionQueueItemIdentity,
  createTranslationExecutionQueueItemConflictError,
  DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES,
  DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY
} from './durableTranslationExecutionQueueRepository.js';

export function createStartupTranslationExecutionQueueRecovery({
  durableRepository,
  activeQueue,
  translationRepository,
  translationCommandService,
  clock = () => new Date().toISOString(),
  leaseDurationMs = 300000,
  leaseIdFactory = randomUUID
} = {}) {
  assertDurableTranslationExecutionQueueRepository(durableRepository);
  assertTranslationExecutionQueue(activeQueue);
  assertOptionalRecoveryTranslationRepository(translationRepository);
  assertOptionalTranslationCommandService(translationCommandService);
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) throw new TypeError('leaseDurationMs must be a positive integer.');
  if (typeof leaseIdFactory !== 'function') throw new TypeError('leaseIdFactory must be a function.');

  const replayedExecutionIds = new Set();

  return Object.freeze({
    async recover() {
      const items = await durableRepository.list();
      const queuedItems = [];
      const processingItems = [];
      const completedItems = [];
      const failedItems = [];
      const itemsByExecutionId = new Map();

      for (const item of items) {
        const existingItem = itemsByExecutionId.get(item.executionId);
        if (existingItem !== undefined) {
          if (compareDurableTranslationExecutionQueueItemIdentity(existingItem, item)
            === DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_IDENTITY.CONFLICT) {
            throw createTranslationExecutionQueueItemConflictError();
          }

          continue;
        }

        itemsByExecutionId.set(item.executionId, item);
        if (item.status === DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.QUEUED) {
          queuedItems.push(item);
        } else if (item.status === DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.PROCESSING) {
          processingItems.push(item);
        } else if (item.status === DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.COMPLETED) {
          completedItems.push(item);
        } else if (item.status === DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.FAILED) {
          failedItems.push(item);
        }
      }

      const now = clock();
      for (const item of queuedItems) {
        if (item.availableAt !== null && item.availableAt > now) continue;
        await enqueueOnce(item);
      }

      for (const item of processingItems) {
        if (!hasExpiredCompleteLease(item, now)) {
          continue;
        }

        assertRecoveryTranslationRepository(translationRepository);
        const execution = await translationRepository.findExecutionById(item.executionId);
        assertFoundExecution(execution, item.executionId);
        const outputs = await translationRepository.listTranslationOutputsByExecution(item.executionId);

        if (isOutputBearingRunningExecution(execution, outputs)) {
          await completeExecution(translationCommandService, execution);
          await durableRepository.updateStatus(item.executionId, DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.COMPLETED);
          await durableRepository.acknowledge(item.executionId);
          continue;
        }

        if (isCompletedExecutionWithOutput(execution, outputs)) {
          await durableRepository.updateStatus(item.executionId, DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.COMPLETED);
          await durableRepository.acknowledge(item.executionId);
          continue;
        }

        if (isFailedExecutionWithoutOutput(execution, outputs)) {
          if (typeof durableRepository.transferClaimToDeadLetter === 'function') {
            const requeuedItem = await durableRepository.requeueExpiredProcessing(item.executionId, now);
            if (requeuedItem === null) continue;
            const claim = await durableRepository.claim(item.executionId, createRecoveryLease(now));
            const request = typeof translationRepository.findRequestById === 'function'
              ? await translationRepository.findRequestById(item.requestId)
              : undefined;
            await durableRepository.transferClaimToDeadLetter(item.executionId, {
              leaseId: claim.leaseId,
              fenceToken: claim.fenceToken,
              failedAt: toIsoUtcTimestamp(execution.completedAt),
              failure: execution.failureInfo,
              ...(execution.providerKey === undefined ? {} : { providerKey: execution.providerKey }),
              providerMetadata: { providerKey: execution.providerKey ?? null },
              executionMetadata: {
                translationRequestId: execution.translationRequestId,
                startedAt: execution.startedAt,
                ...(request?.targetLanguageCode === undefined ? {} : { targetLanguageCode: request.targetLanguageCode })
              }
            });
            continue;
          }
          await durableRepository.updateStatus(item.executionId, DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.FAILED);
          await durableRepository.acknowledge(item.executionId);
          continue;
        }

        if (!isReplayEligible(execution, outputs)) {
          continue;
        }

        if (execution.status === 'running') {
          await translationRepository.updateTranslationExecution(execution.resumeAfterExpiredLease());
        }

        await durableRepository.updateStatus(item.executionId, DURABLE_TRANSLATION_EXECUTION_QUEUE_ITEM_STATUSES.QUEUED);
        await enqueueOnce(item);
      }

      for (const item of completedItems) {
        await acknowledgeTerminalItem(item, 'completed');
      }

      for (const item of failedItems) {
        await acknowledgeTerminalItem(item, 'failed');
      }

      async function enqueueOnce(item) {
        if (replayedExecutionIds.has(item.executionId)) return;
        await activeQueue.enqueue({ executionId: item.executionId, requestId: item.requestId });
        replayedExecutionIds.add(item.executionId);
      }

      function createRecoveryLease(recoveredAt) {
        const leaseId = leaseIdFactory();
        if (typeof leaseId !== 'string' || leaseId.trim().length === 0) throw new TypeError('leaseIdFactory must return a non-empty string.');
        return {
          leaseId,
          claimedAt: recoveredAt,
          leaseExpiresAt: new Date(new Date(recoveredAt).getTime() + leaseDurationMs).toISOString()
        };
      }

      async function acknowledgeTerminalItem(item, status) {
        assertRecoveryTranslationRepository(translationRepository);
        const execution = await translationRepository.findExecutionById(item.executionId);
        if (execution === null || execution === undefined) return;
        const outputs = await translationRepository.listTranslationOutputsByExecution(item.executionId);

        if (
          (status === 'completed' && isCompletedExecutionWithOutput(execution, outputs)) ||
          (status === 'failed' && isFailedExecutionWithoutOutput(execution, outputs))
        ) {
          await durableRepository.acknowledge(item.executionId);
        }
      }
    }
  });
}

function isReplayEligible(execution, outputs) {
  if (execution.status === 'queued') return true;
  return execution.status === 'running' && outputs.length === 0;
}

function isOutputBearingRunningExecution(execution, outputs) {
  return execution.status === 'running' && outputs.length > 0;
}

function isCompletedExecutionWithOutput(execution, outputs) {
  return execution.status === 'completed' && outputs.length > 0;
}

function isFailedExecutionWithoutOutput(execution, outputs) {
  return execution.status === 'failed' && outputs.length === 0;
}

async function completeExecution(translationCommandService, execution) {
  assertTranslationCommandService(translationCommandService);
  await translationCommandService.updateTranslationExecution({
    executionId: execution.id,
    transition: 'complete',
    completedAt: execution.startedAt
  });
}

function hasExpiredCompleteLease(item, now) {
  return new Date(item.leaseExpiresAt).getTime() <= new Date(now).getTime();
}

function toIsoUtcTimestamp(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  throw new TypeError('failed execution completedAt must be an ISO-8601 UTC string or timestamp number.');
}

function assertOptionalRecoveryTranslationRepository(translationRepository) {
  if (translationRepository !== undefined) {
    assertRecoveryTranslationRepository(translationRepository);
  }
}

function assertOptionalTranslationCommandService(translationCommandService) {
  if (translationCommandService !== undefined) {
    assertTranslationCommandService(translationCommandService);
  }
}

function assertTranslationCommandService(translationCommandService) {
  if (!translationCommandService || typeof translationCommandService.updateTranslationExecution !== 'function') {
    throw new TypeError('translationCommandService.updateTranslationExecution must be a function.');
  }
}

function assertRecoveryTranslationRepository(translationRepository) {
  if (!translationRepository || typeof translationRepository !== 'object') {
    throw new TypeError('translationRepository is required.');
  }

  for (const methodName of ['findExecutionById', 'listTranslationOutputsByExecution', 'updateTranslationExecution']) {
    if (typeof translationRepository[methodName] !== 'function') {
      throw new TypeError(`translationRepository.${methodName} must be a function.`);
    }
  }
}

function assertFoundExecution(execution, executionId) {
  if (execution === null || execution === undefined) {
    throw new Error(`TranslationExecution ${executionId} was not found`);
  }
}
