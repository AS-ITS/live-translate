import assert from 'node:assert/strict';
import { promises as fileSystem } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProductionApplicationDependencies } from '../../server/compositionRoot.js';
import { TranslationExecution } from '../../src/domain/translation/index.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

test('production composition keeps duplicate durable submissions to one active item, provider call, and output', async () => {
  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    await createRequestAndQueuedExecution(dependencies, { executionId: 'execution-duplicate' });
    const beforeDuplicate = await dependencies.durableTranslationExecutionQueueRepository.list();

    await dependencies.translationExecutionQueue.enqueue({
      executionId: 'execution-duplicate',
      requestId: 'request-duplicate'
    });

    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), beforeDuplicate);
    assert.equal(dependencies.translationExecutionQueue.size(), 1);

    assert.deepEqual(await dependencies.translationExecutionWorker.processNext(), {
      status: 'processed',
      executionId: 'execution-duplicate'
    });
    assert.equal(providerCalls.length, 1);
    assert.equal(
      (await dependencies.translationRepository.listTranslationOutputsByExecution('execution-duplicate')).length,
      1
    );
  });
});

test('production composition replays queued durable work idempotently in FIFO order', async () => {
  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    await createRequestAndQueuedExecution(dependencies, { executionId: 'execution-first' });
    await createRequestAndQueuedExecution(dependencies, { executionId: 'execution-second' });

    // Simulate a restart after durable submission but before the active worker consumes it.
    assert.deepEqual(dependencies.translationExecutionQueue.dequeue(), {
      executionId: 'execution-first',
      requestId: 'request-first'
    });
    assert.deepEqual(dependencies.translationExecutionQueue.dequeue(), {
      executionId: 'execution-second',
      requestId: 'request-second'
    });
    const durableItemsBeforeRecovery = await dependencies.durableTranslationExecutionQueueRepository.list();

    await dependencies.startupTranslationExecutionQueueRecovery.recover();
    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    assert.equal(dependencies.translationExecutionQueue.size(), 2);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), durableItemsBeforeRecovery);
    assert.deepEqual(await dependencies.translationExecutionWorker.processNext(), {
      status: 'processed',
      executionId: 'execution-first'
    });
    assert.deepEqual(await dependencies.translationExecutionWorker.processNext(), {
      status: 'processed',
      executionId: 'execution-second'
    });
    assert.deepEqual(providerCalls.map((call) => call.sourceText), ['source execution-first', 'source execution-second']);
    assert.equal((await dependencies.translationRepository.listTranslationOutputsByExecution('execution-first')).length, 1);
    assert.equal((await dependencies.translationRepository.listTranslationOutputsByExecution('execution-second')).length, 1);
  });
});

test('production composition recovery does not replay terminal durable items', async () => {
  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    await createRequestAndQueuedExecution(dependencies, { executionId: 'execution-completed' });
    await createRequestAndQueuedExecution(dependencies, { executionId: 'execution-failed' });
    dependencies.translationExecutionQueue.dequeue();
    dependencies.translationExecutionQueue.dequeue();

    await dependencies.translationRepository.updateTranslationExecution(
      executionFor({ executionId: 'execution-completed', requestId: 'request-completed', status: 'completed' })
    );
    await dependencies.translationRepository.updateTranslationExecution(
      executionFor({ executionId: 'execution-failed', requestId: 'request-failed', status: 'failed' })
    );
    await dependencies.durableTranslationExecutionQueueRepository.updateStatus('execution-completed', 'completed');
    await dependencies.durableTranslationExecutionQueueRepository.updateStatus('execution-failed', 'failed');
    const durableItemsBeforeRecovery = await dependencies.durableTranslationExecutionQueueRepository.list();

    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    assert.equal(dependencies.translationExecutionQueue.size(), 0);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), durableItemsBeforeRecovery);
    assert.deepEqual(providerCalls, []);
    assert.deepEqual(await dependencies.translationRepository.listTranslationOutputsByExecution('execution-completed'), []);
    assert.deepEqual(await dependencies.translationRepository.listTranslationOutputsByExecution('execution-failed'), []);
  });
});

test('production composition worker skips non-processable execution lifecycle states', async () => {
  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    const statuses = ['created', 'running', 'completed', 'failed'];

    for (const status of statuses) {
      const executionId = `execution-${status}`;
      const requestId = `request-${status}`;
      await createRequest(dependencies, { requestId });
      await dependencies.translationRepository.createTranslationExecution(executionFor({ executionId, requestId, status }));
      await dependencies.translationExecutionQueue.enqueue({ executionId, requestId });
    }

    for (const status of statuses) {
      const executionId = `execution-${status}`;
      assert.deepEqual(await dependencies.translationExecutionWorker.processNext(), {
        processed: false,
        reason: 'execution_not_processable',
        executionId,
        status
      });
      assert.deepEqual(await dependencies.translationRepository.listTranslationOutputsByExecution(executionId), []);
    }

    assert.deepEqual(providerCalls, []);
  });
});

async function withProductionFixture(run) {
  const directory = await fileSystem.mkdtemp(join(tmpdir(), 'live-translate-wp7-'));
  const sessionRepository = createMemorySessionRepository({ now: () => '2026-07-20T00:00:00.000Z' });
  const providerCalls = [];
  const translationExecutionProvider = Object.freeze({
    async execute(input) {
      providerCalls.push(input);
      return { translatedText: `[fake] ${input.sourceText}` };
    }
  });

  sessionRepository.createSessionRecord({
    id: 'session-wp7',
    startedAt: '2026-07-20T00:00:00.000Z',
    targetLanguageCode: 'fr'
  });

  const dependencies = createProductionApplicationDependencies({
    env: {
      TRANSLATION_DURABLE_QUEUE_ENABLED: 'true',
      TRANSLATION_DURABLE_QUEUE_FILE: join(directory, 'translation-execution-queue.json')
    },
    sessionRepository,
    translationExecutionProvider,
    resolveSavedTranscriptTranslationProvider() {
      throw new Error('saved transcript provider must not be resolved by WP7 queue tests');
    },
    translationQueueClock: { now: () => '2026-07-20T00:00:00.000Z' }
  });

  try {
    await run({ dependencies, providerCalls });
  } finally {
    dependencies.unsubscribeTranslationDomainEvents();
    await fileSystem.rm(directory, { recursive: true, force: true });
  }
}

async function createRequestAndQueuedExecution(dependencies, { executionId }) {
  const requestId = executionId.replace('execution', 'request');
  await createRequest(dependencies, { requestId, executionId });
  await dependencies.translationCommandController.createTranslationExecution({
    id: executionId,
    translationRequestId: requestId,
    providerKey: 'fake',
    startedAt: '2026-07-20T00:01:00.000Z'
  });
}

async function createRequest(dependencies, { requestId, executionId = requestId.replace('request', 'execution') }) {
  await dependencies.translationCommandController.createTranslationRequest({
    id: requestId,
    sessionId: 'session-wp7',
    sourceTranscriptRevisionId: `revision-${requestId}`,
    sourceTranscriptSnapshot: {
      sourceText: `source ${executionId}`,
      sourceLanguageCode: 'en'
    },
    targetLanguageCode: 'fr',
    createdAt: '2026-07-20T00:00:00.000Z'
  });
}

function executionFor({ executionId, requestId, status }) {
  const base = {
    id: executionId,
    translationRequestId: requestId,
    providerKey: 'fake',
    status,
    startedAt: '2026-07-20T00:01:00.000Z'
  };

  if (status === 'completed') {
    return new TranslationExecution({ ...base, completedAt: '2026-07-20T00:02:00.000Z' });
  }

  if (status === 'failed') {
    return new TranslationExecution({
      ...base,
      completedAt: '2026-07-20T00:02:00.000Z',
      failureInfo: { reason: 'test_failure' }
    });
  }

  return new TranslationExecution(base);
}
