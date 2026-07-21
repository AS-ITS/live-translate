import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionSnapshotSyncService } from '../../src/application/sessionSnapshotSyncService.js';
import { createTranslationExecutionRunner } from '../../src/application/translationExecutionRunner.js';
import { createTranslationCommandService } from '../../src/application/translationCommandService.js';
import { createTranslationRepositoryAdapter } from '../../src/infrastructure/translationRepositoryAdapter.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

test('mixed-language source metadata survives rehydration while the provider receives the original text and target language', async () => {
  const sourceText = 'Hello，こんにちは，您好';
  const sessionRepository = createMemorySessionRepository({ now: () => 1000 });
  const syncService = createSessionSnapshotSyncService({ sessionRepository });
  syncService.sync({
    session: { id: 'session-1', startedAt: 100, targetLanguageCode: 'fr', status: 'active' },
    transcriptItems: [
      {
        id: 'source-1', stream: 'source', status: 'final', text: sourceText, sequence: 1,
        sourceLanguageDetection: { detectedLanguageCodes: ['en', 'ja', 'zh-Hant'], coverage: 'complete' }
      }
    ]
  });

  const reloadedRepository = createMemorySessionRepository({ now: () => 1000 });
  createSessionSnapshotSyncService({ sessionRepository: reloadedRepository }).sync({
    session: sessionRepository.getSessionRecord('session-1').sessionRecord,
    transcriptItems: sessionRepository.getSessionRecord('session-1').transcriptItems
  });
  const translationRepository = createTranslationRepositoryAdapter({ sessionRepository: reloadedRepository });
  const commandService = createTranslationCommandService({
    translationRepository,
    domainEventPublisher: { publish() {} }
  });
  const request = commandService.createTranslationRequest({
    id: 'request-1', sessionId: 'session-1', sourceTranscriptRevisionId: 'source-revision:session-1:final',
    sourceTranscriptSnapshot: { items: reloadedRepository.getSessionRecord('session-1').transcriptItems },
    targetLanguageCode: 'fr', createdAt: 1000
  });
  commandService.createTranslationExecution({
    id: 'execution-1', translationRequestId: request.id, startedAt: 1000
  });
  const providerInputs = [];
  const runner = createTranslationExecutionRunner({
    translationRepository,
    translationExecutionProvider: {
      async execute(input) {
        providerInputs.push(input);
        return { translatedText: 'Bonjour', detectedSourceLanguageCode: 'en' };
      }
    },
    clock: () => 1001
  });

  await runner.execute({
    execution: translationRepository.getTranslationExecution('execution-1'),
    payload: { sourceText, targetLanguageCode: 'fr', completedAt: 1002 }
  });

  assert.equal(providerInputs.length, 1);
  assert.equal(providerInputs[0].sourceText, sourceText);
  assert.equal(providerInputs[0].targetLanguageCode, 'fr');
  assert.deepEqual(reloadedRepository.getSessionRecord('session-1').transcriptItems[0].sourceLanguageDetection, {
    detectedLanguageCodes: ['en', 'ja', 'zh-Hant'], coverage: 'complete'
  });
  assert.equal(reloadedRepository.getSessionRecord('session-1').sessionRecord.sourceLanguageDetection, undefined);
  assert.equal(translationRepository.listTranslationOutputsByExecution('execution-1')[0].sourceLanguageDetection, undefined);
  assert.equal(translationRepository.listTranslationOutputsByExecution('execution-1')[0].providerMetadata, null);
});
