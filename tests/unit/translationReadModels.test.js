import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareTranslationOutputDetails,
  mapTranslationExecutionHistoryDTO,
  mapTranslationExecutionToDTO,
  mapTranslationOutputToDetailDTO,
  mapTranslationOutputToSummaryDTO,
  mapTranslationRequestToDTO,
  safeFailureInfo
} from '../../src/readModels/translationReadModels.js';

test('maps request, execution, and output DTOs without mutating domain objects', () => {
  const request = {
    id: 'request-1',
    sourceTranscriptSnapshot: { items: [{ text: 'Hello' }, { text: 'こんにちは' }] },
    targetLanguageCode: 'ja',
    createdAt: 1
  };
  const execution = { id: 'execution-1', translationRequestId: 'request-1', status: 'completed', startedAt: 2, completedAt: 3, failureInfo: null };
  const output = { id: 'output-1', executionId: 'execution-1', translatedText: 'こんにちは', targetLanguageCode: 'ja', createdAt: 4 };

  assert.deepEqual(mapTranslationRequestToDTO(request), {
    id: 'request-1', sourceText: 'Hello\nこんにちは', targetLanguageCode: 'ja', createdAt: 1
  });
  assert.deepEqual(mapTranslationExecutionToDTO(execution, request), {
    id: 'execution-1', translationRequestId: 'request-1', status: 'completed', startedAt: 2, completedAt: 3, failureInfo: null
  });
  assert.deepEqual(mapTranslationOutputToSummaryDTO(output), {
    id: 'output-1', executionId: 'execution-1', translatedText: 'こんにちは', targetLanguageCode: 'ja', createdAt: 4
  });
  assert.deepEqual(mapTranslationOutputToDetailDTO(output), {
    id: 'output-1', executionId: 'execution-1', translatedText: 'こんにちは', targetLanguageCode: 'ja', createdAt: 4,
    requestId: undefined, version: null, source: 'legacy', sourceLanguageCode: null, completedAt: 4
  });
  assert.equal(request.sourceTranscriptSnapshot.items.length, 2);
});

test('preserves transcript polishing metadata and provider model fallback', () => {
  const request = { id: 'request-1', targetLanguageCode: 'en', operation: 'transcript_polishing', segmentRange: null, inputHash: null, model: null };
  const output = {
    id: 'output-1', executionId: 'execution-1', targetLanguageCode: 'en', operation: 'transcript_polishing',
    polishedItems: [], segmentRange: { start: 1, end: 2 }, inputHash: 'hash-1', providerMetadata: { model: 'flash-lite' }
  };

  assert.deepEqual(mapTranslationRequestToDTO(request), {
    id: 'request-1', sourceText: null, targetLanguageCode: 'en', operation: 'transcript_polishing',
    segmentRange: null, inputHash: null, model: null, createdAt: undefined
  });
  assert.deepEqual(mapTranslationOutputToSummaryDTO(output), {
    id: 'output-1', executionId: 'execution-1', translatedText: undefined, targetLanguageCode: 'en', operation: 'transcript_polishing',
    polishedItems: [], segmentRange: { start: 1, end: 2 }, inputHash: 'hash-1', model: 'flash-lite', createdAt: undefined
  });
});

test('history execution mapping sanitizes failure info and preserves terminal metadata', () => {
  const dto = mapTranslationExecutionHistoryDTO({
    id: 'execution-1', status: 'failed', startedAt: 2, completedAt: 3,
    providerAttemptStatus: 'failed', providerAttemptedAt: 'attempted', providerCompletedAt: 'completed',
    failureInfo: { reason: 'failed', status: 401, secret: 'omit' }
  }, { id: 'request-1', targetLanguageCode: 'ja', createdAt: 1 });

  assert.deepEqual(dto, {
    id: 'execution-1', requestId: 'request-1', targetLanguageCode: 'ja', status: 'failed', startedAt: 2, createdAt: 1,
    providerAttemptStatus: 'failed', providerAttemptedAt: 'attempted', providerCompletedAt: 'completed',
    failureInfo: { reason: 'failed', status: 401 }, completedAt: 3
  });
  assert.deepEqual(safeFailureInfo({ message: 'safe', requestConfig: { fields: ['model'], secret: 'omit' } }), {
    message: 'safe', requestConfig: { fields: ['model'] }
  });
});

test('output details sort newest completion first, then id', () => {
  const first = { id: 'output-a', completedAt: '2026-01-01T00:00:00.000Z' };
  const second = { id: 'output-b', completedAt: '2026-02-01T00:00:00.000Z' };
  assert.equal(compareTranslationOutputDetails(first, second) > 0, true);
  assert.equal(compareTranslationOutputDetails({ id: 'output-a', completedAt: 'same' }, { id: 'output-b', completedAt: 'same' }) < 0, true);
});
