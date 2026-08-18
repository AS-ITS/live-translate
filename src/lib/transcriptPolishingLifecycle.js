import { transcriptPolishingInputHash } from './transcriptPolishing.js';
import { cueRefinementInputHash, cueRefinementItem } from './cueContent.js';
import { stableSubtitleGroup, subtitleResegmentationInputHash } from './subtitleResegmentation.js';

export const TRANSCRIPT_POLISHING_MODEL = 'gemini-3.5-flash-lite';
export const TRANSCRIPT_POLISHING_PROVIDER_KEY = 'gemini';

export function createTranscriptPolishingLifecycle({ apiClient, onStateChange = () => {}, now = () => new Date().toISOString() } = {}) {
  if (!apiClient || typeof apiClient.createTranslationRequest !== 'function' || typeof apiClient.createTranslationExecution !== 'function') {
    throw new TypeError('apiClient must provide translation command methods.');
  }
  const states = new Map();

  return Object.freeze({
    submitStableGroup({ sessionId, targetLanguageCode, sourceLanguageCode, cues, inputHash, segmentRange } = {}) {
      const items = stableSubtitleGroup(cues);
      if (!sessionId || !targetLanguageCode || items.length === 0) return Promise.resolve(null);
      const hash = inputHash || subtitleResegmentationInputHash(items);
      const requestId = `subtitle-resegment-request:${sessionId}:${hash}`;
      const executionId = `subtitle-resegment-execution:${sessionId}:${hash}`;
      const startedAt = now();
      const snapshot = {
        operation: 'transcript_polishing',
        mode: 'subtitle_resegment',
        inputHash: hash,
        sourceLanguageCode,
        targetLanguageCode,
        items: items.map((cue) => ({
          cueId: cue.cueId,
          sequence: cue.sequence,
          rawSource: cue.rawSource ?? cue.sourceText,
          rawTranslation: cue.rawTranslation ?? cue.translatedText
        }))
      };
      return Promise.resolve()
        .then(() => apiClient.createTranslationRequest({
          id: requestId,
          sessionId,
          sourceTranscriptRevisionId: `subtitle-revision:${sessionId}`,
          targetLanguageCode,
          operation: 'transcript_polishing',
          segmentRange: segmentRange || { fromSequence: items[0].sequence, toSequence: items.at(-1).sequence, segmentIds: [...new Set(items.map((cue) => cue.segmentId).filter(Boolean))] },
          inputHash: hash,
          sourceTranscriptSnapshot: snapshot,
          createdAt: startedAt
        }))
        .then(() => apiClient.createTranslationExecution({ id: executionId, translationRequestId: requestId, providerKey: TRANSCRIPT_POLISHING_PROVIDER_KEY, startedAt }))
        .then(() => {
          onStateChange({ status: 'queued', inputHash: hash, executionId, mode: 'subtitle_resegment' });
          return { requestId, executionId, inputHash: hash, mode: 'subtitle_resegment', items };
        });
    },
    submitCue({ sessionId, targetLanguageCode, sourceLanguageCode, cue, contextCues = [] } = {}) {
      if (!sessionId || !targetLanguageCode || !cue?.cueId) return Promise.resolve(null);
      const refinement = cueRefinementItem(cue);
      const hash = refinement.inputHash || cueRefinementInputHash(cue);
      const requestId = `polishing-request:${sessionId}:${cue.cueId}:v${refinement.version}`;
      const executionId = `polishing-execution:${sessionId}:${cue.cueId}:v${refinement.version}`;
      const startedAt = now();
      const items = [...contextCues, cue].slice(-3).map((item) => cueRefinementItem(item));
      const snapshot = {
        operation: 'transcript_polishing',
        inputHash: hash,
        cueId: cue.cueId,
        refinementVersion: refinement.version,
        refinementItems: items,
        sourceLanguageCode,
        targetLanguageCode
      };
      return Promise.resolve()
        .then(() => apiClient.createTranslationRequest({
          id: requestId,
          sessionId,
          sourceTranscriptRevisionId: `source-revision:${sessionId}:final`,
          targetLanguageCode,
          operation: 'transcript_polishing',
          segmentRange: { fromSequence: cue.sequence, toSequence: cue.sequence, segmentIds: [cue.segmentId].filter(Boolean) },
          inputHash: hash,
          sourceTranscriptSnapshot: snapshot,
          createdAt: startedAt
        }))
        .then(() => apiClient.createTranslationExecution({
          id: executionId,
          translationRequestId: requestId,
          providerKey: TRANSCRIPT_POLISHING_PROVIDER_KEY,
          startedAt
        }))
        .then(() => {
          onStateChange({ status: 'queued', inputHash: hash, cueId: cue.cueId, executionId });
          return { requestId, executionId, inputHash: hash, cueId: cue.cueId, version: refinement.version };
        })
        .catch((error) => {
          onStateChange({ status: 'failed', cueId: cue.cueId, error });
          throw error;
        });
    },
    submit({ sessionId, targetLanguageCode, sourceLanguageCode, cues, inputHash, segmentRange } = {}) {
      if (!sessionId || !targetLanguageCode || !Array.isArray(cues) || cues.length === 0) return Promise.resolve(null);
      const hash = inputHash || transcriptPolishingInputHash(cues);
      const state = stateFor(sessionId);
      if (state.hashes.has(hash) || state.inFlight) {
        state.dirty = true;
        return Promise.resolve(null);
      }
      state.inFlight = true;
      const requestId = `polishing-request:${sessionId}:${hash}`;
      const executionId = `polishing-execution:${sessionId}:${hash}`;
      const startedAt = now();
      const sourceTranscriptRevisionId = `source-revision:${sessionId}:final`;
      const sourceText = cues.map((cue) => cue.sourceText).filter(Boolean).join('\n');
      const snapshot = {
        operation: 'transcript_polishing',
        inputHash: hash,
        segmentRange,
        sourceLanguageCode,
        sourceText,
        polishingItems: cues.map((cue) => ({
          cueId: cue.cueId,
          sequence: cue.sequence,
          segmentId: cue.segmentId,
          sourceText: cue.sourceText,
          translationText: cue.translationText
        }))
      };
      return Promise.resolve()
        .then(() => apiClient.createTranslationRequest({
          id: requestId,
          sessionId,
          sourceTranscriptRevisionId,
          targetLanguageCode,
          operation: 'transcript_polishing',
          segmentRange,
          inputHash: hash,
          sourceTranscriptSnapshot: snapshot,
          createdAt: startedAt
        }))
        .then(() => apiClient.createTranslationExecution({
          id: executionId,
          translationRequestId: requestId,
          providerKey: TRANSCRIPT_POLISHING_PROVIDER_KEY,
          startedAt
        }))
        .then(() => {
          state.hashes.add(hash);
          state.inFlight = false;
          onStateChange({ status: 'queued', inputHash: hash, segmentRange, executionId });
          if (state.dirty) {
            state.dirty = false;
            return null;
          }
          return { requestId, executionId, inputHash: hash };
        })
        .catch((error) => {
          state.inFlight = false;
          onStateChange({ status: 'failed', error });
          throw error;
        });
    },
    reset(sessionId) { states.delete(sessionId); },
    state(sessionId) { return { ...(states.get(sessionId) || { inFlight: false, dirty: false, hashes: new Set() }), hashes: undefined }; }
  });

  function stateFor(sessionId) {
    let state = states.get(sessionId);
    if (!state) {
      state = { inFlight: false, dirty: false, hashes: new Set() };
      states.set(sessionId, state);
    }
    return state;
  }
}
