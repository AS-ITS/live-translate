import assert from 'node:assert/strict';
import { promises as fileSystem } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProductionApplicationDependencies } from '../../server/compositionRoot.js';
import { TranslationExecution, TranslationOutput } from '../../src/domain/translation/index.js';
import { createFileDurableTranslationExecutionQueueRepository } from '../../src/infrastructure/fileDurableTranslationExecutionQueueRepository.js';
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
    assert.equal(providerCalls[0].providerIdempotencyKey, 'translation-execution:execution-duplicate');
    assert.equal(
      (await dependencies.translationRepository.listTranslationOutputsByExecution('execution-duplicate')).length,
      1
    );
  });
});

test('production composition persists and acknowledges the worker claim lease around a successful runner', async () => {
  let releaseProvider;
  let providerStarted;
  const providerStartedPromise = new Promise((resolve) => { providerStarted = resolve; });
  const providerReleasePromise = new Promise((resolve) => { releaseProvider = resolve; });

  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    const executionId = 'execution-lease-success';
    await createRequestAndQueuedExecution(dependencies, { executionId });

    const processing = dependencies.translationExecutionWorker.processNext();
    await providerStartedPromise;

    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), [{
      executionId,
      requestId: 'request-lease-success',
      enqueuedAt: '2026-07-20T00:00:00.000Z',
      status: 'processing',
      fenceToken: 1,
      attempt: 0,
      availableAt: null,
      lastFailure: null,
      leaseId: 'lease-L1',
      claimedAt: '2026-07-20T00:00:00.000Z',
      leaseExpiresAt: '2026-07-20T00:05:00.000Z'
    }]);
    assert.equal(providerCalls.length, 1);

    releaseProvider({ translatedText: 'done' });
    await processing;

    assert.equal((await dependencies.translationRepository.getTranslationExecution(executionId)).status, 'completed');
    assert.equal((await dependencies.translationRepository.listTranslationOutputsByExecution(executionId)).length, 1);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), []);
  }, {
    translationQueueLeaseIdFactory: () => 'lease-L1',
    providerExecute: async () => {
      providerStarted();
      return providerReleasePromise;
    }
  });
});

test('production worker renews a long-running claim and leaves it active for recovery', async () => {
  let releaseProvider;
  const providerReleasePromise = new Promise((resolve) => { releaseProvider = resolve; });
  let providerStarted;
  const providerStartedPromise = new Promise((resolve) => { providerStarted = resolve; });
  const scheduler = fakeScheduler();
  let now = '2026-07-20T00:00:00.000Z';

  await withProductionFixture(async ({ dependencies }) => {
    const executionId = 'execution-heartbeat';
    await createRequestAndQueuedExecution(dependencies, { executionId });
    const processing = dependencies.translationExecutionWorker.processNext();
    await providerStartedPromise;

    now = '2026-07-20T00:02:00.000Z';
    await scheduler.runNext();
    assert.equal(
      (await dependencies.durableTranslationExecutionQueueRepository.peek()).leaseExpiresAt,
      '2026-07-20T00:07:00.000Z'
    );

    await dependencies.startupTranslationExecutionQueueRecovery.recover();
    assert.equal(dependencies.translationExecutionQueue.size(), 0);

    releaseProvider({ translatedText: 'done' });
    await processing;
    assert.equal(scheduler.activeCount(), 0);
  }, {
    translationQueueClock: { now: () => now },
    translationQueueLeaseHeartbeatScheduler: scheduler,
    translationQueueLeaseIdFactory: () => 'lease-heartbeat',
    providerExecute: async () => {
      providerStarted();
      return providerReleasePromise;
    }
  });
});

test('production recovery preserves an active lease while replaying other queued durable work', async () => {
  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    await createRequestAndQueuedExecution(dependencies, { executionId: 'execution-active-lease' });
    await createRequestAndQueuedExecution(dependencies, { executionId: 'execution-replay-queued' });
    dependencies.translationExecutionQueue.dequeue();
    dependencies.translationExecutionQueue.dequeue();
    const activeLease = {
      leaseId: 'lease-active',
      claimedAt: '2026-07-20T00:00:00.000Z',
      leaseExpiresAt: '2026-07-20T00:05:00.000Z'
    };
    await dependencies.durableTranslationExecutionQueueRepository.claim('execution-active-lease', activeLease);

    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    assert.deepEqual(dependencies.translationExecutionQueue.dequeue(), {
      executionId: 'execution-replay-queued',
      requestId: 'request-replay-queued'
    });
    assert.equal(dependencies.translationExecutionQueue.size(), 0);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), [
      {
        executionId: 'execution-active-lease',
        requestId: 'request-active-lease',
        enqueuedAt: '2026-07-20T00:00:00.000Z',
        status: 'processing',
        fenceToken: 1,
        attempt: 0,
        availableAt: null,
        lastFailure: null,
        ...activeLease
      },
      {
        executionId: 'execution-replay-queued',
        requestId: 'request-replay-queued',
        enqueuedAt: '2026-07-20T00:00:00.000Z',
        status: 'queued',
        fenceToken: 0,
        attempt: 0,
        availableAt: null,
        lastFailure: null
      }
    ]);
    assert.deepEqual(providerCalls, []);
  });
});

test('reclaimed lease receives a new worker lease and rejects stale acknowledgement before completion', async () => {
  let releaseProvider;
  let providerStarted;
  const providerStartedPromise = new Promise((resolve) => { providerStarted = resolve; });
  const providerReleasePromise = new Promise((resolve) => { releaseProvider = resolve; });

  await withProductionFixture(async ({ dependencies }) => {
    const executionId = 'execution-reclaimed-lease';
    await createRequestAndQueuedExecution(dependencies, { executionId });
    dependencies.translationExecutionQueue.dequeue();
    await dependencies.durableTranslationExecutionQueueRepository.claim(executionId, expiredLease({ leaseId: 'lease-L1' }));

    await dependencies.startupTranslationExecutionQueueRecovery.recover();
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.peek(), {
      executionId,
      requestId: 'request-reclaimed-lease',
      enqueuedAt: '2026-07-20T00:00:00.000Z',
      status: 'queued',
      fenceToken: 1,
      attempt: 0,
      availableAt: null,
      lastFailure: null
    });

    const processing = dependencies.translationExecutionWorker.processNext();
    await providerStartedPromise;
    const claimedByWorkerB = await dependencies.durableTranslationExecutionQueueRepository.peek();
    assert.equal(claimedByWorkerB.leaseId, 'lease-L2');
    assert.equal(claimedByWorkerB.leaseExpiresAt, '2026-07-20T00:05:00.000Z');
    await assert.rejects(
      () => dependencies.durableTranslationExecutionQueueRepository.acknowledgeClaim(executionId, { leaseId: 'lease-L1', fenceToken: 1 }),
      (error) => error.code === 'translation_execution_queue_lease_ownership_error'
    );
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.peek(), claimedByWorkerB);

    releaseProvider({ translatedText: 'done' });
    await processing;
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), []);
  }, {
    translationQueueLeaseIdFactory: () => 'lease-L2',
    providerExecute: async () => {
      providerStarted();
      return providerReleasePromise;
    }
  });
});

test('production composition fences late L1 persistence after L2 reclaims and completes', async () => {
  let now = '2026-07-20T00:00:00.000Z';
  let releaseL1;
  let releaseL2;
  let l1Started;
  let l2Started;
  const l1StartedPromise = new Promise((resolve) => { l1Started = resolve; });
  const l2StartedPromise = new Promise((resolve) => { l2Started = resolve; });
  const l1Result = new Promise((resolve) => { releaseL1 = resolve; });
  const l2Result = new Promise((resolve) => { releaseL2 = resolve; });
  let leaseNumber = 0;
  let providerNumber = 0;

  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    const executionId = 'execution-fenced-reclaim';
    await createRequestAndQueuedExecution(dependencies, { executionId });

    const l1 = dependencies.translationExecutionWorker.processNext();
    await l1StartedPromise;
    const l1Item = await dependencies.durableTranslationExecutionQueueRepository.peek();
    assert.equal(l1Item.fenceToken, 1);

    now = '2026-07-20T00:06:00.000Z';
    await dependencies.startupTranslationExecutionQueueRecovery.recover();
    const l2 = dependencies.translationExecutionWorker.processNext();
    await l2StartedPromise;
    const l2Item = await dependencies.durableTranslationExecutionQueueRepository.peek();
    assert.equal(l2Item.leaseId, 'lease-L2');
    assert.equal(l2Item.fenceToken, 2);

    releaseL1({ translatedText: 'late L1 output' });
    await assert.rejects(l1, (error) => error.code === 'translation_execution_queue_lease_ownership_error');
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.peek(), l2Item);
    assert.deepEqual(await dependencies.translationRepository.listTranslationOutputsByExecution(executionId), []);

    releaseL2({ translatedText: 'L2 output' });
    await l2;
    assert.equal(providerCalls.length, 2);
    assert.equal((await dependencies.translationRepository.getTranslationExecution(executionId)).status, 'completed');
    assert.equal((await dependencies.translationRepository.listTranslationOutputsByExecution(executionId)).length, 1);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), []);
  }, {
    translationQueueClock: { now: () => now },
    translationQueueLeaseIdFactory: () => `lease-L${++leaseNumber}`,
    translationQueueLeaseHeartbeatScheduler: fakeScheduler(),
    idempotency: { mode: 'guaranteed' },
    providerExecute: async () => {
      providerNumber += 1;
      if (providerNumber === 1) {
        l1Started();
        return l1Result;
      }
      l2Started();
      return l2Result;
    }
  });
});

test('reclaimed work keeps provider failure identity and acknowledges its new lease', async () => {
  const providerError = new Error('reclaimed provider failed');
  let rejectProvider;
  let providerStarted;
  const providerStartedPromise = new Promise((resolve) => { providerStarted = resolve; });
  const providerFailurePromise = new Promise((resolve, reject) => { rejectProvider = reject; });

  await withProductionFixture(async ({ dependencies }) => {
    const executionId = 'execution-reclaimed-failure';
    await createRequestAndQueuedExecution(dependencies, { executionId });
    dependencies.translationExecutionQueue.dequeue();
    await dependencies.durableTranslationExecutionQueueRepository.claim(executionId, expiredLease({ leaseId: 'lease-L1' }));
    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    const processing = dependencies.translationExecutionWorker.processNext();
    await providerStartedPromise;
    assert.equal((await dependencies.durableTranslationExecutionQueueRepository.peek()).leaseId, 'lease-L2');
    rejectProvider(providerError);

    await assert.rejects(processing, (error) => error === providerError);
    assert.equal((await dependencies.translationRepository.getTranslationExecution(executionId)).status, 'failed');
    assert.deepEqual(await dependencies.translationRepository.listTranslationOutputsByExecution(executionId), []);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), []);
  }, {
    translationQueueLeaseIdFactory: () => 'lease-L2',
    providerExecute: async () => {
      providerStarted();
      return providerFailurePromise;
    }
  });
});

test('production composition recovers queued work, completes it, and acknowledges durable items', async () => {
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
    assert.equal((await dependencies.translationRepository.getTranslationExecution('execution-first')).status, 'completed');
    assert.equal((await dependencies.translationRepository.getTranslationExecution('execution-second')).status, 'completed');
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), []);
  });
});

test('expired processing lease recovers crash-before-runner work and completes it', async () => {
  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    await createRequestAndQueuedExecution(dependencies, { executionId: 'execution-expired' });
    dependencies.translationExecutionQueue.dequeue();
    await dependencies.durableTranslationExecutionQueueRepository.claim('execution-expired', expiredLease());

    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    assert.deepEqual(await dependencies.translationExecutionWorker.processNext(), {
      status: 'processed',
      executionId: 'execution-expired'
    });
    assert.equal(providerCalls.length, 1);
    assert.equal((await dependencies.translationRepository.getTranslationExecution('execution-expired')).status, 'completed');
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), []);
  });
});

test('expired processing lease recovers crash-before-runner work and acknowledges failure', async () => {
  const providerError = new Error('fake provider failed');

  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    await createRequestAndQueuedExecution(dependencies, { executionId: 'execution-expired-failure' });
    dependencies.translationExecutionQueue.dequeue();
    await dependencies.durableTranslationExecutionQueueRepository.claim('execution-expired-failure', expiredLease());

    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    await assert.rejects(
      dependencies.translationExecutionWorker.processNext(),
      (error) => error === providerError
    );
    assert.equal(providerCalls.length, 1);
    assert.equal((await dependencies.translationRepository.getTranslationExecution('execution-expired-failure')).status, 'failed');
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), []);
  }, { providerError });
});

test('expired processing lease resumes a running execution without output and completes it', async () => {
  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    const executionId = 'execution-running-success';
    await createRequestAndQueuedExecution(dependencies, { executionId });
    dependencies.translationExecutionQueue.dequeue();
    await markExecutionRunning(dependencies, executionId);
    await dependencies.durableTranslationExecutionQueueRepository.claim(executionId, expiredLease());

    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    assert.equal((await dependencies.translationRepository.getTranslationExecution(executionId)).status, 'queued');
    assert.deepEqual(await dependencies.translationExecutionWorker.processNext(), { status: 'processed', executionId });
    assert.equal(providerCalls.length, 1);
    assert.equal((await dependencies.translationRepository.getTranslationExecution(executionId)).status, 'completed');
    assert.equal((await dependencies.translationRepository.listTranslationOutputsByExecution(executionId)).length, 1);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), []);
  });
});

test('expired processing lease resumes a running execution without output and preserves provider failure', async () => {
  const providerError = new Error('running execution provider failed');

  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    const executionId = 'execution-running-failure';
    await createRequestAndQueuedExecution(dependencies, { executionId });
    dependencies.translationExecutionQueue.dequeue();
    await markExecutionRunning(dependencies, executionId);
    await dependencies.durableTranslationExecutionQueueRepository.claim(executionId, expiredLease());

    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    await assert.rejects(dependencies.translationExecutionWorker.processNext(), (error) => error === providerError);
    assert.equal(providerCalls.length, 1);
    assert.equal((await dependencies.translationRepository.getTranslationExecution(executionId)).status, 'failed');
    assert.deepEqual(await dependencies.translationRepository.listTranslationOutputsByExecution(executionId), []);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), []);
  }, { providerError });
});

test('expired processing running execution with output reconciles and acknowledges without provider replay', async () => {
  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    const executionId = 'execution-running-output';
    await createRequestAndQueuedExecution(dependencies, { executionId });
    dependencies.translationExecutionQueue.dequeue();
    await markExecutionRunning(dependencies, executionId);
    await dependencies.translationRepository.createTranslationOutput(new TranslationOutput({
      id: `${executionId}-output-0`,
      executionId,
      sequence: 0,
      translatedText: 'already persisted',
      targetLanguageCode: 'fr',
      createdAt: '2026-07-20T00:02:00.000Z'
    }));
    await dependencies.durableTranslationExecutionQueueRepository.claim(executionId, expiredLease());
    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    assert.equal(dependencies.translationExecutionQueue.size(), 0);
    assert.equal(providerCalls.length, 0);
    assert.equal((await dependencies.translationRepository.getTranslationExecution(executionId)).status, 'completed');
    assert.equal((await dependencies.translationRepository.listTranslationOutputsByExecution(executionId)).length, 1);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), []);
  });
});

test('expired processing completed execution with output finalizes durable state without provider replay', async () => {
  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    const executionId = 'execution-completed-processing';
    await createRequestAndQueuedExecution(dependencies, { executionId });
    dependencies.translationExecutionQueue.dequeue();
    await markExecutionRunning(dependencies, executionId);
    await createOutput(dependencies, executionId);
    const requestId = executionId.replace('execution', 'request');
    await dependencies.translationRepository.updateTranslationExecution(
      executionFor({ executionId, requestId, status: 'completed' })
    );
    await dependencies.durableTranslationExecutionQueueRepository.claim(executionId, expiredLease());

    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    assert.equal(dependencies.translationExecutionQueue.size(), 0);
    assert.deepEqual(providerCalls, []);
    assert.equal((await dependencies.translationRepository.getTranslationExecution(executionId)).status, 'completed');
    assert.equal((await dependencies.translationRepository.listTranslationOutputsByExecution(executionId)).length, 1);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), []);
  });
});

test('recovery retains completed state after acknowledgement failure and retries only acknowledgement on next startup', async () => {
  const acknowledgementError = new Error('reconciliation acknowledgement failed');
  let acknowledgementAttempts = 0;

  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    const executionId = 'execution-reconciliation-ack-failure';
    await createRequestAndQueuedExecution(dependencies, { executionId });
    dependencies.translationExecutionQueue.dequeue();
    await markExecutionRunning(dependencies, executionId);
    await createOutput(dependencies, executionId);
    await dependencies.durableTranslationExecutionQueueRepository.claim(executionId, expiredLease());

    await assert.rejects(
      dependencies.startupTranslationExecutionQueueRecovery.recover(),
      (error) => error === acknowledgementError
    );

    assert.deepEqual(providerCalls, []);
    assert.equal((await dependencies.translationRepository.getTranslationExecution(executionId)).status, 'completed');
    assert.equal((await dependencies.translationRepository.listTranslationOutputsByExecution(executionId)).length, 1);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), [{
      executionId,
      requestId: executionId.replace('execution', 'request'),
      enqueuedAt: '2026-07-20T00:00:00.000Z',
      status: 'completed',
      fenceToken: 1,
      attempt: 0,
      availableAt: null,
      lastFailure: null
    }]);

    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    assert.equal(acknowledgementAttempts, 2);
    assert.equal(dependencies.translationExecutionQueue.size(), 0);
    assert.deepEqual(providerCalls, []);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), []);
  }, {
    fileDurableTranslationExecutionQueueRepositoryFactory(options) {
      const repository = createFileDurableTranslationExecutionQueueRepository(options);
      return Object.freeze({
        ...repository,
        async acknowledge(executionId) {
          acknowledgementAttempts += 1;
          if (acknowledgementAttempts === 1) throw acknowledgementError;
          return repository.acknowledge(executionId);
        }
      });
    }
  });
});

test('expired processing failed execution without output finalizes durable state without provider replay', async () => {
  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    const executionId = 'execution-failed-processing';
    const requestId = executionId.replace('execution', 'request');
    await createRequestAndQueuedExecution(dependencies, { executionId });
    dependencies.translationExecutionQueue.dequeue();
    await dependencies.translationRepository.updateTranslationExecution(
      executionFor({ executionId, requestId, status: 'failed' })
    );
    await dependencies.durableTranslationExecutionQueueRepository.claim(executionId, expiredLease());

    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    const execution = await dependencies.translationRepository.getTranslationExecution(executionId);
    assert.equal(dependencies.translationExecutionQueue.size(), 0);
    assert.deepEqual(providerCalls, []);
    assert.equal(execution.status, 'failed');
    assert.deepEqual(execution.failureInfo, { reason: 'test_failure' });
    assert.deepEqual(await dependencies.translationRepository.listTranslationOutputsByExecution(executionId), []);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), []);
  });
});

test('recovery retains failed state after DLQ transfer failure and retries only transfer on next startup', async () => {
  const transferError = new Error('failed DLQ transfer');
  let transferAttempts = 0;
  let now = '2026-07-20T00:00:00.000Z';

  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    const executionId = 'execution-failed-ack-failure';
    const requestId = executionId.replace('execution', 'request');
    await createRequestAndQueuedExecution(dependencies, { executionId });
    dependencies.translationExecutionQueue.dequeue();
    await dependencies.translationRepository.updateTranslationExecution(
      executionFor({ executionId, requestId, status: 'failed' })
    );
    await dependencies.durableTranslationExecutionQueueRepository.claim(executionId, expiredLease());

    await assert.rejects(
      dependencies.startupTranslationExecutionQueueRecovery.recover(),
      (error) => error === transferError
    );

    assert.deepEqual(providerCalls, []);
    const failedExecution = await dependencies.translationRepository.getTranslationExecution(executionId);
    assert.deepEqual(failedExecution.failureInfo, {
      reason: 'test_failure'
    });
    assert.deepEqual(await dependencies.translationRepository.listTranslationOutputsByExecution(executionId), []);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), [{
      executionId,
      requestId,
      enqueuedAt: '2026-07-20T00:00:00.000Z',
      status: 'processing',
      fenceToken: 2,
      attempt: 0,
      availableAt: null,
      lastFailure: null,
      leaseId: 'lease-wp2',
      claimedAt: '2026-07-20T00:00:00.000Z',
      leaseExpiresAt: '2026-07-20T00:05:00.000Z'
    }]);

    now = '2026-07-20T00:05:00.000Z';
    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    assert.equal(transferAttempts, 2);
    assert.equal(dependencies.translationExecutionQueue.size(), 0);
    assert.deepEqual(providerCalls, []);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), []);
  }, {
    translationQueueClock: { now: () => now },
    fileDurableTranslationExecutionQueueRepositoryFactory(options) {
      const repository = createFileDurableTranslationExecutionQueueRepository(options);
      return Object.freeze({
        ...repository,
        async transferClaimToDeadLetter(executionId, transfer) {
          transferAttempts += 1;
          if (transferAttempts === 1) throw transferError;
          return repository.transferClaimToDeadLetter(executionId, transfer);
        }
      });
    }
  });
});

test('expired processing completed execution without output remains durable and is never replayed', async () => {
  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    const executionId = 'execution-terminal-completed';
    const requestId = executionId.replace('execution', 'request');
    await createRequestAndQueuedExecution(dependencies, { executionId });
    dependencies.translationExecutionQueue.dequeue();
    await dependencies.translationRepository.updateTranslationExecution(executionFor({ executionId, requestId, status: 'completed' }));
    await dependencies.durableTranslationExecutionQueueRepository.claim(executionId, expiredLease());
    const durableItemsBeforeRecovery = await dependencies.durableTranslationExecutionQueueRepository.list();

    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    assert.equal(dependencies.translationExecutionQueue.size(), 0);
    assert.deepEqual(providerCalls, []);
    assert.deepEqual(
      await dependencies.durableTranslationExecutionQueueRepository.list(),
      durableItemsBeforeRecovery.filter((item) => item.executionId !== 'execution-failed')
    );
  });
});

test('expired processing failed execution with output remains durable and is never replayed', async () => {
  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    const executionId = 'execution-failed-output';
    const requestId = executionId.replace('execution', 'request');
    await createRequestAndQueuedExecution(dependencies, { executionId });
    dependencies.translationExecutionQueue.dequeue();
    await createOutput(dependencies, executionId);
    await dependencies.translationRepository.updateTranslationExecution(
      executionFor({ executionId, requestId, status: 'failed' })
    );
    await dependencies.durableTranslationExecutionQueueRepository.claim(executionId, expiredLease());
    const durableItemsBeforeRecovery = await dependencies.durableTranslationExecutionQueueRepository.list();

    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    const failedExecution = await dependencies.translationRepository.getTranslationExecution(executionId);
    assert.equal(dependencies.translationExecutionQueue.size(), 0);
    assert.deepEqual(providerCalls, []);
    assert.equal(failedExecution.status, 'failed');
    assert.deepEqual(failedExecution.failureInfo, { reason: 'test_failure' });
    assert.equal((await dependencies.translationRepository.listTranslationOutputsByExecution(executionId)).length, 1);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), durableItemsBeforeRecovery);
  });
});

test('production composition recovery replays only queued durable items and preserves non-queued items', async () => {
  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    await createRequestAndQueuedExecution(dependencies, { executionId: 'execution-completed' });
    await createRequestAndQueuedExecution(dependencies, { executionId: 'execution-failed' });
    await createRequestAndQueuedExecution(dependencies, { executionId: 'execution-processing' });
    dependencies.translationExecutionQueue.dequeue();
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
    await dependencies.durableTranslationExecutionQueueRepository.claim('execution-processing', {
      leaseId: 'lease-processing',
      claimedAt: '2026-07-20T00:00:00.000Z',
      leaseExpiresAt: '2026-07-20T00:05:00.000Z'
    });
    const durableItemsBeforeRecovery = await dependencies.durableTranslationExecutionQueueRepository.list();

    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    assert.equal(dependencies.translationExecutionQueue.size(), 0);
    assert.deepEqual(
      await dependencies.durableTranslationExecutionQueueRepository.list(),
      durableItemsBeforeRecovery.filter((item) => item.executionId !== 'execution-failed')
    );
    assert.deepEqual(providerCalls, []);
    assert.deepEqual(await dependencies.translationRepository.listTranslationOutputsByExecution('execution-completed'), []);
    assert.deepEqual(await dependencies.translationRepository.listTranslationOutputsByExecution('execution-failed'), []);
  });
});

test('production composition recovers failed work, acknowledges it, and rethrows the provider error', async () => {
  const providerError = new Error('fake provider failed');

  await withProductionFixture(async ({ dependencies, providerCalls }) => {
    await createRequestAndQueuedExecution(dependencies, { executionId: 'execution-failure' });
    assert.deepEqual(dependencies.translationExecutionQueue.dequeue(), {
      executionId: 'execution-failure',
      requestId: 'request-failure'
    });

    await dependencies.startupTranslationExecutionQueueRecovery.recover();

    await assert.rejects(
      dependencies.translationExecutionWorker.processNext(),
      (error) => error === providerError
    );

    assert.equal(providerCalls.length, 1);
    assert.equal((await dependencies.translationRepository.getTranslationExecution('execution-failure')).status, 'failed');
    assert.deepEqual(await dependencies.translationRepository.listTranslationOutputsByExecution('execution-failure'), []);
    assert.deepEqual(await dependencies.durableTranslationExecutionQueueRepository.list(), []);
  }, { providerError });
});

test('production composition propagates acknowledgement failure after terminal persistence and retains the durable item', async () => {
  const acknowledgementError = new Error('acknowledgement failed');

  await withProductionFixture(async ({ dependencies }) => {
    await createRequestAndQueuedExecution(dependencies, { executionId: 'execution-acknowledgement-failure' });

    await assert.rejects(
      dependencies.translationExecutionWorker.processNext(),
      (error) => error === acknowledgementError
    );

    assert.equal(
      (await dependencies.translationRepository.getTranslationExecution('execution-acknowledgement-failure')).status,
      'completed'
    );
    assert.equal(
      (await dependencies.translationRepository.listTranslationOutputsByExecution('execution-acknowledgement-failure')).length,
      1
    );
    assert.deepEqual(
      await dependencies.durableTranslationExecutionQueueRepository.list(),
      [
        {
          executionId: 'execution-acknowledgement-failure',
          requestId: 'request-acknowledgement-failure',
          enqueuedAt: '2026-07-20T00:00:00.000Z',
          status: 'processing',
          fenceToken: 1,
          attempt: 0,
          availableAt: null,
          lastFailure: null,
          leaseId: 'lease-wp2',
          claimedAt: '2026-07-20T00:00:00.000Z',
          leaseExpiresAt: '2026-07-20T00:05:00.000Z'
        }
      ]
    );
  }, {
    fileDurableTranslationExecutionQueueRepositoryFactory(options) {
      const repository = createFileDurableTranslationExecutionQueueRepository(options);
      return Object.freeze({
        ...repository,
        async acknowledgeClaim() {
          throw acknowledgementError;
        }
      });
    }
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

async function withProductionFixture(run, options = {}) {
  const directory = await fileSystem.mkdtemp(join(tmpdir(), 'live-translate-wp7-'));
  const sessionRepository = createMemorySessionRepository({ now: () => '2026-07-20T00:00:00.000Z' });
  const providerCalls = [];
  const translationExecutionProvider = Object.freeze({
    idempotency: options.idempotency ?? Object.freeze({ mode: 'unknown' }),
    async execute(input) {
      providerCalls.push(input);
      if (options.providerExecute !== undefined) {
        return options.providerExecute(input);
      }
      if (options.providerError !== undefined) {
        throw options.providerError;
      }
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
    translationQueueClock: { now: () => '2026-07-20T00:00:00.000Z' },
    translationQueueLeaseIdFactory: () => 'lease-wp2',
    ...options
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

function fakeScheduler() {
  const active = new Set();
  return {
    set(callback) {
      active.add(callback);
      return callback;
    },
    clear(callback) {
      active.delete(callback);
    },
    async runNext() {
      const callback = active.values().next().value;
      if (callback !== undefined) {
        active.delete(callback);
        await callback();
      }
    },
    activeCount() {
      return active.size;
    }
  };
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

async function markExecutionRunning(dependencies, executionId) {
  const execution = await dependencies.translationRepository.getTranslationExecution(executionId);
  await dependencies.translationRepository.updateTranslationExecution(execution.start(execution.startedAt));
}

async function createOutput(dependencies, executionId) {
  await dependencies.translationRepository.createTranslationOutput(new TranslationOutput({
    id: `${executionId}-output-0`,
    executionId,
    sequence: 0,
    translatedText: 'already persisted',
    targetLanguageCode: 'fr',
    createdAt: '2026-07-20T00:02:00.000Z'
  }));
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

function expiredLease(overrides = {}) {
  return {
    leaseId: 'expired-lease',
    claimedAt: '2026-07-19T23:54:00.000Z',
    leaseExpiresAt: '2026-07-19T23:59:00.000Z',
    ...overrides
  };
}
