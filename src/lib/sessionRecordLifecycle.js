import { transcriptItemsForStream } from './transcript.js';
import { meetingGlossaryAliasesForTarget } from './meetingGlossary.js';

const STREAMS = ['source', 'translation'];

export function buildSessionRecordInput(options = {}) {
  return {
    startedAt: options.startedAt,
    ...(options.id ? { id: options.id } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(options.name !== undefined ? { name: options.name } : {}),
    targetLanguageCode: options.targetLanguageCode,
    targetLanguageLabel: options.targetLanguageLabel || null,
    sourceLanguageCode: options.sourceLanguageCode || null,
    ...(Object.hasOwn(options, 'echoTargetLanguage') ? { echoTargetLanguage: options.echoTargetLanguage !== false } : {}),
    ...(Object.hasOwn(options, 'shouldRecordInputAudio') ? { shouldRecordInputAudio: options.shouldRecordInputAudio === true } : {}),
    meetingId: options.meetingId || null,
    recordingId: options.recordingId || null,
    segmentId: options.segmentId || null,
    ...(Object.hasOwn(options, 'meetingGlossaryEntries')
      ? { meetingGlossaryEntries: Array.isArray(options.meetingGlossaryEntries)
        ? options.meetingGlossaryEntries.map((entry) => ({
          ...entry,
          replacementAliases: meetingGlossaryAliasesForTarget(entry?.replacementAliases, options.targetLanguageCode)
        }))
        : [] }
      : {}),
    selectedInputDeviceId: options.selectedInputDeviceId || null,
    inputDeviceLabelSnapshot: options.inputDeviceLabelSnapshot || null
  };
}

export function createActiveSessionRecord(repository, input = {}) {
  const existing = input.id ? repository.getSessionRecord(input.id)?.sessionRecord : null;
  if (existing) {
    return repository.updateSessionRecord(existing.id, {
      status: 'active',
      meetingId: input.meetingId,
      segmentId: input.segmentId
    });
  }
  return repository.createSessionRecord(input);
}

export function appendNewFinalTranscriptItems(repository, sessionId, previousTranscriptState, nextTranscriptState) {
  if (!sessionId) {
    return [];
  }

  const detail = repository.getSessionRecord(sessionId);
  const sessionSegmentId = detail?.sessionRecord?.segmentId || null;
  const existingIds = new Set((detail?.transcriptItems || []).map((item) => item.id));
  const appended = [];

  for (const item of newFinalTranscriptItems(previousTranscriptState, nextTranscriptState)) {
    if (existingIds.has(item.id)) {
      continue;
    }

    const stored = repository.appendTranscriptItem(sessionId, {
      ...item,
      ...(item.segmentId || !sessionSegmentId ? {} : { segmentId: sessionSegmentId })
    });
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
