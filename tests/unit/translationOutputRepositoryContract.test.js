import assert from 'node:assert/strict';
import test from 'node:test';
import { TranslationExecution, TranslationOutput, TranslationRequest } from '../../src/domain/translation/index.js';
import { createTranslationRepositoryAdapter } from '../../src/infrastructure/translationRepositoryAdapter.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

test('allocates immutable output versions per session and target language', () => {
  const sessions = createMemorySessionRepository();
  for (const id of ['s-1', 's-2']) sessions.createSessionRecord({ id, startedAt: 0, targetLanguageCode: 'ja' });
  const repository = createTranslationRepositoryAdapter({ sessionRepository: sessions });
  createFormalOutput(repository, 's-1', 'r-1', 'e-1', 'ja');
  createFormalOutput(repository, 's-1', 'r-2', 'e-2', 'ja');
  createFormalOutput(repository, 's-1', 'r-3', 'e-3', 'en');
  createFormalOutput(repository, 's-2', 'r-4', 'e-4', 'ja');

  assert.deepEqual(repository.listTranslationOutputsBySession('s-1').map((output) => [output.targetLanguageCode, output.version]), [
    ['ja', 1], ['ja', 2], ['en', 1]
  ]);
  assert.deepEqual(repository.listTranslationOutputsBySession('s-2').map((output) => output.version), [1]);
  const original = repository.createTranslationOutput(new TranslationOutput({ id: 'different-id', executionId: 'e-1', sequence: 0, translatedText: 'ignored', targetLanguageCode: 'ja', createdAt: 2, sessionId: 's-1', requestId: 'r-1' }));
  assert.equal(original.version, 1);
  assert.equal(repository.listTranslationOutputsBySession('s-1').length, 3);
});

function createFormalOutput(repository, sessionId, requestId, executionId, targetLanguageCode) {
  repository.createTranslationRequest(new TranslationRequest({ id: requestId, sessionId, sourceTranscriptRevisionId: `rev-${requestId}`, sourceTranscriptSnapshot: { sourceText: 'source', sourceLanguageCode: 'mixed' }, targetLanguageCode, createdAt: 1 }));
  repository.createTranslationExecution(new TranslationExecution({ id: executionId, translationRequestId: requestId, status: 'completed', startedAt: 1, completedAt: 2 }));
  return repository.createTranslationOutput(new TranslationOutput({ id: `o-${executionId}`, executionId, sequence: 0, translatedText: 'translated', targetLanguageCode, createdAt: 2, completedAt: 2, sessionId, requestId, sourceText: 'source', sourceLanguageCode: 'mixed' }));
}
