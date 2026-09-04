import { cueRefinementInputHash, rawSourceForCue } from './cueContent.js';

export const CUE_TRANSLATION_OPERATION = 'cue_translation';
export const CUE_TRANSLATION_MODEL = 'gemini-3.5-flash';

export function createCueTranslationLifecycle({ apiClient, onStateChange = () => {}, now = () => new Date().toISOString() } = {}) {
  if (!apiClient || typeof apiClient.createTranslationRequest !== 'function' || typeof apiClient.createTranslationExecution !== 'function') {
    throw new TypeError('apiClient must provide translation command methods.');
  }
  const submitted = new Set();

  return Object.freeze({
    submitCue({ sessionId, sourceLanguageCode, targetLanguageCode, cue } = {}) {
      if (!sessionId || !cue?.cueId || !targetLanguageCode || !rawSourceForCue(cue)) return Promise.resolve(null);
      const inputHash = cueRefinementInputHash({ ...cue, rawTranslation: '' });
      const key = `${sessionId}:${cue.cueId}:v${cue.sequence}:${inputHash}:${targetLanguageCode}`;
      if (submitted.has(key)) return Promise.resolve(null);
      submitted.add(key);
      const requestId = `cue-translation-request:${sessionId}:${cue.cueId}:${inputHash}`;
      const executionId = `cue-translation-execution:${sessionId}:${cue.cueId}:${inputHash}`;
      const createdAt = now();
      const sourceText = rawSourceForCue(cue);
      return Promise.resolve()
        .then(() => apiClient.createTranslationRequest({
          id: requestId,
          sessionId,
          sourceTranscriptRevisionId: `source-revision:${sessionId}:final`,
          targetLanguageCode,
          operation: CUE_TRANSLATION_OPERATION,
          segmentRange: { fromSequence: cue.sequence, toSequence: cue.sequence, segmentIds: [cue.segmentId].filter(Boolean) },
          inputHash,
          model: CUE_TRANSLATION_MODEL,
          sourceTranscriptSnapshot: {
            operation: CUE_TRANSLATION_OPERATION,
            cueId: cue.cueId,
            sequence: cue.sequence,
            sourceText,
            sourceLanguageCode,
            targetLanguageCode,
            inputHash
          },
          createdAt
        }))
        .then(() => apiClient.createTranslationExecution({
          id: executionId,
          translationRequestId: requestId,
          providerKey: 'gemini',
          startedAt: createdAt
        }))
        .then(() => {
          onStateChange({ status: 'queued', cueId: cue.cueId, executionId, inputHash });
          return { requestId, executionId, cueId: cue.cueId, inputHash, version: 1 };
        })
        .catch((error) => {
          submitted.delete(key);
          onStateChange({ status: 'failed', cueId: cue.cueId, error });
          throw error;
        });
    },
    reset() { submitted.clear(); }
  });
}
