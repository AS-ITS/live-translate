import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationDependencies } from '../../server/compositionRoot.js';
import { createFakeTranslationExecutionProvider } from '../../src/infrastructure/fakeTranslationExecutionProvider.js';
import { createFakeTranslationExecutionProviderResolver } from '../../src/infrastructure/fakeTranslationExecutionProviderResolver.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

test('retranslation worker restores canonical request metadata and creates versioned outputs', async () => {
  const sessionRepository = createMemorySessionRepository();
  sessionRepository.createSessionRecord({ id: 'session-1', startedAt: 0, targetLanguageCode: 'ja' });
  sessionRepository.appendTranscriptItem('session-1', { id: 'source-1', stream: 'source', status: 'final', sequence: 0, text: 'Hello', languageCode: 'en', startedAt: 0, finalizedAt: 1 });
  const calls = [];
  const provider = createFakeTranslationExecutionProvider({ calls });
  const dependencies = createApplicationDependencies({
    sessionRepository,
    translationExecutionProviderResolver: createFakeTranslationExecutionProviderResolver({ translationExecutionProvider: provider }),
    idGenerator: ((value = 0) => (prefix) => `${prefix}-${++value}`)(),
    clock: () => 2
  });

  await dependencies.sessionRetranslationCommandService.submitRetranslation({ sessionId: 'session-1', targetLanguageCode: 'ja' });
  await dependencies.translationExecutionWorker.processNext();
  await dependencies.sessionRetranslationCommandService.submitRetranslation({ sessionId: 'session-1', targetLanguageCode: 'ja' });
  await dependencies.translationExecutionWorker.processNext();

  const outputs = await dependencies.translationRepository.listTranslationOutputsBySession('session-1');
  const history = await dependencies.sessionReadController.listSessions();
  const derivedDetail = await dependencies.sessionReadController.getSession('retranslation-session:translation-execution-2');

  assert.deepEqual(outputs.map((output) => output.version), [1, 2]);
  assert.deepEqual(outputs.map((output) => output.sourceText), ['Hello', 'Hello']);
  assert.deepEqual(outputs.map((output) => output.sourceTranscriptMetadata.revisionId), ['source-revision:session-1:final', 'source-revision:session-1:final']);
  assert.deepEqual(calls.map((call) => [call.sourceText, call.sourceLanguageCode, call.targetLanguageCode]), [['Hello', 'en', 'ja'], ['Hello', 'en', 'ja']]);
  assert.deepEqual(history.map((record) => [record.id, record.recordKind]), [
    ['session-1', 'session'],
    ['retranslation-session:translation-execution-2', 'retranslation'],
    ['retranslation-session:translation-execution-4', 'retranslation']
  ]);
  assert.deepEqual(derivedDetail.session.retranslatedFrom, {
    sessionId: 'session-1',
    startedAt: 0,
    requestId: 'translation-request-1',
    executionId: 'translation-execution-2',
    outputId: 'translation-execution-2-output-0'
  });
  assert.equal(derivedDetail.readingContent.translationArticle.text, '[fake] Hello');
});

test('retranslation can save different target languages and provider keys from the same source transcript', async () => {
  const sessionRepository = createMemorySessionRepository();
  sessionRepository.createSessionRecord({ id: 'session-provider-versions', startedAt: 0, targetLanguageCode: 'ja' });
  sessionRepository.appendTranscriptItem('session-provider-versions', { id: 'source-1', stream: 'source', status: 'final', sequence: 0, text: 'Canonical original', languageCode: 'en', startedAt: 0, finalizedAt: 1 });
  sessionRepository.appendTranscriptItem('session-provider-versions', { id: 'translation-1', stream: 'translation', status: 'final', sequence: 1, text: 'Old translation must not be input', startedAt: 0, finalizedAt: 1 });
  const calls = [];
  const provider = createFakeTranslationExecutionProvider({ calls });
  const dependencies = createApplicationDependencies({
    sessionRepository,
    translationExecutionProviderResolver: {
      resolve(providerKey) {
        if (!['gemini', 'fake'].includes(providerKey)) throw new Error(`translation execution provider not found: ${providerKey}`);
        return provider;
      }
    },
    idGenerator: ((value = 0) => (prefix) => `${prefix}-${++value}`)(),
    clock: () => 2
  });

  await dependencies.sessionRetranslationCommandService.submitRetranslation({ sessionId: 'session-provider-versions', targetLanguageCode: 'fr', providerKey: 'gemini' });
  await dependencies.translationExecutionWorker.processNext();
  await dependencies.sessionRetranslationCommandService.submitRetranslation({ sessionId: 'session-provider-versions', targetLanguageCode: 'de', providerKey: 'fake' });
  await dependencies.translationExecutionWorker.processNext();

  const outputs = await dependencies.translationRepository.listTranslationOutputsBySession('session-provider-versions');
  const requests = await dependencies.translationRepository.listTranslationRequestsBySession('session-provider-versions');
  const executions = (await Promise.all(requests.map((request) => dependencies.translationRepository.listTranslationExecutionsByRequest(request.id)))).flat();

  assert.deepEqual(outputs.map((output) => [output.targetLanguageCode, output.sourceText]), [
    ['fr', 'Canonical original'],
    ['de', 'Canonical original']
  ]);
  assert.deepEqual(executions.map((execution) => execution.providerKey), ['gemini', 'fake']);
  assert.deepEqual(calls.map((call) => [call.sourceText, call.targetLanguageCode, call.providerKey]), [
    ['Canonical original', 'fr', 'gemini'],
    ['Canonical original', 'de', 'fake']
  ]);
});
