import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationDependencies } from '../../server/compositionRoot.js';
import { createFakeTranslationExecutionProvider } from '../../src/infrastructure/fakeTranslationExecutionProvider.js';
import { createFakeTranslationExecutionProviderResolver } from '../../src/infrastructure/fakeTranslationExecutionProviderResolver.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

test('production application composition creates a queued retranslation without provider execution or output', async () => {
  const sessionRepository = createMemorySessionRepository();
  sessionRepository.createSessionRecord({ id: 'session-1', startedAt: 0, targetLanguageCode: 'ja' });
  sessionRepository.appendTranscriptItem('session-1', {
    id: 'source-1', stream: 'source', status: 'final', text: 'Hello', sequence: 0, startedAt: 0, finalizedAt: 1
  });
  const providerCalls = [];
  const provider = createFakeTranslationExecutionProvider({ calls: providerCalls });
  const queue = { items: [], enqueue(item) { this.items.push(item); }, dequeue() { return null; }, size() { return this.items.length; } };
  const dependencies = createApplicationDependencies({
    sessionRepository,
    translationExecutionQueue: queue,
    translationExecutionProviderResolver: createFakeTranslationExecutionProviderResolver({ translationExecutionProvider: provider }),
    idGenerator: ((value = 0) => (prefix) => `${prefix}-${++value}`)(),
    clock: () => 1
  });

  const result = await dependencies.sessionRetranslationCommandService.submitRetranslation({
    sessionId: 'session-1', targetLanguageCode: 'ja'
  });
  const requests = await dependencies.translationRepository.listTranslationRequestsBySession('session-1');
  const executions = await dependencies.translationRepository.listTranslationExecutionsByRequest(requests[0].id);
  const outputs = await dependencies.translationRepository.listTranslationOutputsByExecution(executions[0].id);

  assert.equal(result.execution.status, 'queued');
  assert.equal(requests[0].sourceTranscriptSnapshot.sourceText, 'Hello');
  assert.deepEqual(queue.items, [{ executionId: executions[0].id, requestId: requests[0].id }]);
  assert.deepEqual(providerCalls, []);
  assert.deepEqual(outputs, []);
});
