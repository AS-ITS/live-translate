import assert from 'node:assert/strict';
import test from 'node:test';
import { createRetranslationSessionMaterializer } from '../../src/application/translation/retranslationSessionMaterializer.js';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';

test('materializes a completed derived session record from a translation output', async () => {
  const sessionRepository = createMemorySessionRepository();
  sessionRepository.createSessionRecord({ id: 'session-1', startedAt: 1000, targetLanguageCode: 'ja' });
  sessionRepository.appendTranscriptItem('session-1', {
    id: 'source-1',
    stream: 'source',
    status: 'final',
    text: 'Hello',
    sequence: 0,
    startedAt: 1000,
    finalizedAt: 1100,
    languageCode: 'en'
  });

  const materializer = createRetranslationSessionMaterializer({ sessionRepository, clock: () => 2000 });
  const record = await materializer.materialize({
    output: {
      id: 'output-1',
      executionId: 'execution-1',
      requestId: 'request-1',
      sessionId: 'session-1',
      translatedText: 'Bonjour',
      targetLanguageCode: 'fr',
      createdAt: 2000,
      completedAt: 2100,
      sourceTranscriptMetadata: {
        sourceTranscriptSnapshot: {
          items: [{
            id: 'source-1',
            stream: 'source',
            status: 'final',
            text: 'Hello',
            sequence: 0,
            startedAt: 1000,
            finalizedAt: 1100,
            languageCode: 'en'
          }]
        }
      }
    }
  });

  const detail = sessionRepository.getSessionRecord('retranslation-session:execution-1');

  assert.equal(record.id, 'retranslation-session:execution-1');
  assert.equal(record.status, 'completed');
  assert.equal(record.recordKind, 'retranslation');
  assert.deepEqual(record.retranslatedFrom, {
    sessionId: 'session-1',
    startedAt: 1000,
    requestId: 'request-1',
    executionId: 'execution-1',
    outputId: 'output-1'
  });
  assert.deepEqual(detail.transcriptItems.map((item) => [item.stream, item.text]), [
    ['source', 'Hello'],
    ['translation', 'Bonjour']
  ]);
});

test('materialization is idempotent for the same execution output', async () => {
  const sessionRepository = createMemorySessionRepository();
  sessionRepository.createSessionRecord({ id: 'session-1', startedAt: 1000, targetLanguageCode: 'ja' });
  const materializer = createRetranslationSessionMaterializer({ sessionRepository, clock: () => 2000 });
  const output = {
    id: 'output-1',
    executionId: 'execution-1',
    requestId: 'request-1',
    sessionId: 'session-1',
    translatedText: 'Bonjour',
    targetLanguageCode: 'fr',
    createdAt: 2000,
    completedAt: 2100,
    sourceText: 'Hello'
  };

  await materializer.materialize({ output });
  await materializer.materialize({ output });

  assert.deepEqual(sessionRepository.listSessionRecords().map((record) => record.id), [
    'session-1',
    'retranslation-session:execution-1'
  ]);
});
