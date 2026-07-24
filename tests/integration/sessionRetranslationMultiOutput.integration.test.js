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
