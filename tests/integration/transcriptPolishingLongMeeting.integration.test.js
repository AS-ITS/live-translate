import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationExecutionRunner } from '../../src/application/translationExecutionRunner.js';
import { createRetryPolicy } from '../../src/application/translation/retryPolicy.js';
import { createTranscriptPolishingRateLimiter } from '../../src/application/translation/transcriptPolishingRateLimiter.js';
import { TranslationExecution } from '../../src/domain/translation/index.js';

test('13-segment polishing stays within RPM, counts retries, and resumes after limiter restart', async () => {
  let currentTime = 0;
  const attempts = [];
  const completedCueIds = new Set();
  const providerAttempts = new Map();
  const repository = createRepository();
  const provider = {
    async execute(input) {
      attempts.push(currentTime);
      const key = input.providerIdempotencyKey;
      const count = (providerAttempts.get(key) ?? 0) + 1;
      providerAttempts.set(key, count);
      if (count === 1) throw new Error('deterministic retry');
      return {
        translatedText: `refined ${input.sourceText}`,
        refinedSource: input.sourceText,
        refinedTranslation: `refined ${input.sourceText}`
      };
    }
  };

  const createRunner = () => createTranslationExecutionRunner({
    translationRepository: repository,
    translationExecutionProvider: provider,
    retryPolicy: createRetryPolicy({ maxRetries: 1 }),
    transcriptPolishingRateLimiter: createTranscriptPolishingRateLimiter({
      maxRequestsPerMinute: 2,
      now: () => currentTime,
      wait: async (delayMs) => { currentTime += delayMs; }
    })
  });

  const runner = createRunner();
  for (let index = 0; index < 13; index += 1) {
    const cueId = `cue:segment-${index + 1}:1`;
    await runner.execute(inputFor(`execution-${index + 1}`, cueId));
    completedCueIds.add(cueId);
  }

  assert.equal(attempts.length, 26);
  assertSlidingWindow(attempts, 2);
  assert.equal(completedCueIds.size, 13);
  assert.deepEqual([...repository.outputs].map((output) => output.sourceText), Array.from(
    { length: 13 },
    (_, index) => `raw cue ${index + 1}`
  ));

  const restartedRunner = createRunner();
  await restartedRunner.execute(inputFor('execution-pending-14', 'cue:segment-14:1'));
  assert.equal(repository.outputs.filter((output) => output.executionId === 'execution-pending-14').length, 1);
  assert.equal(repository.executions.get('execution-pending-14').status, 'completed');
});

function inputFor(executionId, cueId) {
  const payload = {
    id: executionId,
    translationRequestId: `request-${executionId}`,
    startedAt: 0,
    operation: 'transcript_polishing',
    sourceText: `raw cue ${Number(executionId.match(/(\d+)$/)?.[1] ?? 14)}`,
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en',
    refinementTargets: [{ targetCueId: cueId, version: 1, inputHash: `hash-${cueId}` }]
  };
  const { sourceText, sourceLanguageCode, targetLanguageCode, ...executionFields } = payload;
  return {
    execution: new TranslationExecution(executionFields),
    payload,
    repositoryResult: null
  };
}

function createRepository() {
  const executions = new Map();
  const outputs = [];
  return {
    executions,
    outputs,
    createTranslationRequest(request) { return request; },
    getTranslationRequest() { return null; },
    findRequestById() { return null; },
    updateTranslationRequest(request) { return request; },
    listTranslationRequestsBySession() { return []; },
    createTranslationExecution(execution) { executions.set(execution.id, execution); return execution; },
    getTranslationExecution() { return null; },
    findExecutionById(executionId) { return executions.get(executionId); },
    updateTranslationExecution(execution) { executions.set(execution.id, execution); return execution; },
    listTranslationExecutionsByRequest() { return []; },
    createTranslationOutput(output) { outputs.push(output); return output; },
    listTranslationOutputsByExecution() { return []; },
    listTranslationOutputsBySession() { return []; },
    listTranslationOutputsByRequest() { return []; },
    getTranslationOutput() { return null; },
    deleteTranslationOutput() { return false; }
  };
}

function assertSlidingWindow(timestamps, maxRequestsPerMinute) {
  for (let index = 0; index < timestamps.length; index += 1) {
    const windowStart = timestamps[index] - 60000;
    const count = timestamps.slice(0, index + 1).filter((timestamp) => timestamp > windowStart).length;
    assert.ok(count <= maxRequestsPerMinute, `RPM exceeded at attempt ${index + 1}`);
  }
}
