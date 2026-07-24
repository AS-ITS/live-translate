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

test('compact translation history includes safe failure details for failed executions', async () => {
  const calls = [];
  const service = createTranslationHistoryQueryService({
    sessionRepository: {
      getSessionRecord() {
        return { sessionRecord: { id: 'session-1' }, transcriptItems: [] };
      }
    },
    translationRepository: repository(calls, {
      executions: [{
        id: 'execution-1',
        translationRequestId: 'request-1',
        status: 'failed',
        startedAt: 2,
        completedAt: 3,
        failureInfo: {
          reason: 'provider_execution_failed',
          errorName: 'GeminiHttpError',
          code: 'unauthorized',
          status: 401,
          message: 'Gemini HTTP request failed: unauthorized (401).',
          secret: 'must-not-leak'
        }
      }],
      outputs: []
    })
  });

  const result = await service.listSessionTranslations({
    sessionId: 'session-1',
    includeReadModel: true
  });

  assert.deepEqual(result.translationHistory.executions, [{
    id: 'execution-1',
    requestId: 'request-1',
    targetLanguageCode: 'ja',
    status: 'failed',
    failureInfo: {
      reason: 'provider_execution_failed',
      errorName: 'GeminiHttpError',
      code: 'unauthorized',
      status: 401,
      message: 'Gemini HTTP request failed: unauthorized (401).'
    },
    completedAt: 3
  }]);
});

function repository(calls, overrides = {}) {
  const noop = () => {};
  const executions = overrides.executions || [{ id: 'execution-1', translationRequestId: 'request-1', status: 'completed', startedAt: 2, completedAt: 3, failureInfo: null }];
  const outputs = Object.hasOwn(overrides, 'outputs')
    ? overrides.outputs
    : [{ id: 'output-1', executionId: 'execution-1', translatedText: 'こんにちは', targetLanguageCode: 'ja', createdAt: 4 }];
  return {
    createTranslationRequest: noop, getTranslationRequest: noop, findRequestById: noop, updateTranslationRequest: noop,
    listTranslationRequestsBySession(id) { calls.push(['requests', id]); return [{ id: 'request-1', targetLanguageCode: 'ja', sourceTranscriptSnapshot: { sourceText: 'Hello こんにちは' }, createdAt: 1 }]; },
    createTranslationExecution: noop, getTranslationExecution: noop, findExecutionById: noop, updateTranslationExecution: noop,
    listTranslationExecutionsByRequest(id) { calls.push(['executions', id]); return executions; },
    createTranslationOutput: noop, listTranslationOutputsByExecution(id) { calls.push(['outputs', id]); return outputs; }, listTranslationOutputsBySession: noop, listTranslationOutputsByRequest: noop, getTranslationOutput: noop
  };
}
