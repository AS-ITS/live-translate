import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslationHistoryQueryService } from '../../src/application/translationHistoryQueryService.js';

test('translation history reads only the requested session and preserves source detection without writes', async () => {
  const calls = [];
  const service = createTranslationHistoryQueryService({
    sessionRepository: { getSessionRecord(id) { calls.push(['session', id]); return id === 'session-1' ? { sessionRecord: { id }, transcriptItems: [{ id: 'source-1', stream: 'source', sourceLanguageDetection: { detectedLanguageCodes: ['en', 'ja'], coverage: 'partial' } }] } : null; } },
    translationRepository: repository(calls)
  });
  const result = await service.listSessionTranslations({ sessionId: 'session-1', targetLanguageCode: 'ja' });
  assert.deepEqual(result, { sessionId: 'session-1', translations: [{ request: { id: 'request-1', sourceText: 'Hello こんにちは', targetLanguageCode: 'ja', createdAt: 1 }, execution: { id: 'execution-1', translationRequestId: 'request-1', status: 'completed', startedAt: 2, completedAt: 3, failureInfo: null }, output: { id: 'output-1', executionId: 'execution-1', translatedText: 'こんにちは', targetLanguageCode: 'ja', createdAt: 4 }, sourceLanguageDetections: [{ transcriptItemId: 'source-1', detectedLanguageCodes: ['en', 'ja'], coverage: 'partial' }] }] });
  assert.deepEqual(calls.map(([name]) => name), ['session', 'requests', 'executions', 'outputs']);
});

function repository(calls) {
  const noop = () => {};
  return {
    createTranslationRequest: noop, getTranslationRequest: noop, findRequestById: noop, updateTranslationRequest: noop,
    listTranslationRequestsBySession(id) { calls.push(['requests', id]); return [{ id: 'request-1', targetLanguageCode: 'ja', sourceTranscriptSnapshot: { sourceText: 'Hello こんにちは' }, createdAt: 1 }]; },
    createTranslationExecution: noop, getTranslationExecution: noop, findExecutionById: noop, updateTranslationExecution: noop,
    listTranslationExecutionsByRequest(id) { calls.push(['executions', id]); return [{ id: 'execution-1', translationRequestId: id, status: 'completed', startedAt: 2, completedAt: 3, failureInfo: null }]; },
    createTranslationOutput: noop, listTranslationOutputsByExecution(id) { calls.push(['outputs', id]); return [{ id: 'output-1', executionId: id, translatedText: 'こんにちは', targetLanguageCode: 'ja', createdAt: 4 }]; }, listTranslationOutputsBySession: noop, listTranslationOutputsByRequest: noop, getTranslationOutput: noop
  };
}
