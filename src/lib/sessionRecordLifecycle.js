import { transcriptItemsForStream } from './transcript.js';

const STREAMS = ['source', 'translation'];

export function buildSessionRecordInput(options = {}) {
  return {
    startedAt: options.startedAt,
    targetLanguageCode: options.targetLanguageCode,
    targetLanguageLabel: options.targetLanguageLabel || null,
    sourceLanguageCode: options.sourceLanguageCode || null,
    selectedInputDeviceId: options.selectedInputDeviceId || null,
    inputDeviceLabelSnapshot: options.inputDeviceLabelSnapshot || null
  };
}

export function createActiveSessionRecord(repository, input = {}) {
  return repository.createSessionRecord(input);
}

export function appendNewFinalTranscriptItems(repository, sessionId, previousTranscriptState, nextTranscriptState) {
  if (!sessionId) {
    return [];
  }

  const existingIds = new Set((repository.getSessionRecord(sessionId)?.transcriptItems || []).map((item) => item.id));
  const appended = [];

  for (const item of newFinalTranscriptItems(previousTranscriptState, nextTranscriptState)) {
    if (existingIds.has(item.id)) {
      continue;
    }

    const stored = repository.appendTranscriptItem(sessionId, item);
    existingIds.add(item.id);
    appended.push(stored);
  }

  return appended;
}

export function buildFinalizePatch(options = {}) {
  return {
    status: options.status,
    failureReason: options.failureReason ?? null,
    failureCategory: options.failureCategory ?? null
  };
}

export function finalizeActiveSessionRecord(repository, sessionId, patch = {}) {
  if (!sessionId) {
    return null;
  }

  return repository.finalizeSessionRecord(sessionId, patch);
}

function newFinalTranscriptItems(previousTranscriptState, nextTranscriptState) {
  const previousFinalIds = new Set(finalTranscriptItems(previousTranscriptState).map((item) => item.id));

  return finalTranscriptItems(nextTranscriptState).filter((item) => !previousFinalIds.has(item.id));
}

function finalTranscriptItems(transcriptState) {
  return STREAMS.flatMap((stream) => transcriptItemsForStream(transcriptState, stream)).filter((item) => item.status === 'final');
}
