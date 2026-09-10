import { buildTranscriptArticleParagraphs, formatTranscriptArticleText } from '../lib/transcript.js';
import { sanitizeAudioArtifactsForDTO } from '../infrastructure/sessionAudioArtifacts.js';
import { meetingGlossaryAliasesForTarget } from '../lib/meetingGlossary.js';

const EMPTY_TRANSCRIPT_SUMMARY = Object.freeze({
  totalItems: 0,
  sourceFinalCount: 0,
  translationFinalCount: 0,
  hasTranscript: false
});

export function mapMeetingToHistoryListItem({ meeting, segments = [] } = {}) {
  const normalizedSegments = sortedSegments(segments);
  const transcriptItems = transcriptItemsFromSegments({ meeting, segments: normalizedSegments });
  const startedAt = firstFiniteTimestamp(meeting?.startedAt, ...normalizedSegments.map((segment) => segment.startedAt));
  const endedAt = firstFiniteTimestamp(meeting?.endedAt, latestEndedAt(normalizedSegments));

  return {
    id: meeting?.id,
    status: meeting?.status ?? null,
    name: meeting?.name ?? null,
    sourceLanguageCode: meeting?.sourceLanguageCode ?? null,
    targetLanguageCode: meeting?.targetLanguageCode ?? null,
    echoTargetLanguage: meeting?.echoTargetLanguage !== false,
    shouldRecordInputAudio: meeting?.shouldRecordInputAudio === true,
    createdAt: meeting?.createdAt ?? null,
    updatedAt: meeting?.updatedAt ?? null,
    startedAt,
    endedAt,
    durationMs: durationBetween(startedAt, endedAt),
    segmentSummary: buildSegmentSummary(normalizedSegments),
    transcriptSummary: summarizeTranscriptItems(transcriptItems),
    failureInfo: copyRecord(meeting?.failureInfo),
    recordKind: 'meeting'
  };
}

export function mapMeetingToDetailDTO({ meeting, segments = [], audioArtifacts = {}, cloudAudioArtifacts = [] } = {}) {
  const normalizedSegments = sortedSegments(segments);
  const transcriptItems = transcriptItemsFromSegments({ meeting, segments: normalizedSegments });
  const cues = finalCuesFromSegments(normalizedSegments);
  const summary = mapMeetingToHistoryListItem({ meeting, segments: normalizedSegments });

  return {
    meeting: {
      ...summary,
      glossaryEntries: Array.isArray(meeting?.glossaryEntries)
        ? meeting.glossaryEntries.map((entry) => ({
          ...entry,
          replacementAliases: meetingGlossaryAliasesForTarget(entry?.replacementAliases, meeting?.targetLanguageCode)
        }))
        : [],
      privateGlossaryEntries: normalizePrivateGlossaryEntries(meeting?.privateGlossaryEntries, meeting?.targetLanguageCode),
      name: meeting?.name ?? null,
      sourceLanguageCode: meeting?.sourceLanguageCode ?? null,
      targetLanguageCode: meeting?.targetLanguageCode ?? null
    },
    segments: normalizedSegments.map(mapSegmentToDTO),
    timeline: normalizedSegments.map(mapSegmentToTimelineItem),
    transcriptItems,
    cues,
    audioArtifacts: sanitizeAudioArtifactsForDTO(audioArtifacts, { meetingId: meeting?.id }),
    cloudAudioArtifacts: sanitizeCloudAudioArtifacts(cloudAudioArtifacts),
    readingContent: buildReadingContent(transcriptItems),
    recordKind: 'meeting'
  };
}

function sanitizeCloudAudioArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return [];
  return artifacts
    .filter((artifact) => artifact?.status === 'ready' && artifact?.id && artifact?.meetingId)
    .map((artifact) => ({
      id: artifact.id,
      meetingId: artifact.meetingId,
      segmentId: artifact.segmentId ?? null,
      segmentSequence: Number.isInteger(artifact.segmentSequence) ? artifact.segmentSequence : null,
      kind: artifact.kind,
      status: artifact.status,
      fileName: artifact.fileName || 'recording.webm',
      byteSize: Number.isFinite(artifact.byteSize) ? artifact.byteSize : 0,
      mimeType: artifact.mimeType || 'audio/webm',
      createdAt: artifact.createdAt ?? null
    }))
    .sort((left, right) => (left.segmentSequence ?? Number.MAX_SAFE_INTEGER) - (right.segmentSequence ?? Number.MAX_SAFE_INTEGER));
}

function finalCuesFromSegments(segments = []) {
  return segments
    .flatMap((segment) => (segment?.checkpoint?.refinedSubtitleStatus === 'completed' && Array.isArray(segment?.checkpoint?.refinedSubtitleCues) && segment.checkpoint.refinedSubtitleCues.length > 0
      ? segment.checkpoint.refinedSubtitleCues.map((cue) => ({ ...cue, segmentSequence: segment.sequence }))
      : Array.isArray(segment?.checkpoint?.finalCues)
        ? segment.checkpoint.finalCues.map((cue) => ({ ...cue, segmentSequence: segment.sequence }))
      : []))
    .filter((cue) => cue?.status === 'final')
    .sort((left, right) => (
      left.segmentSequence - right.segmentSequence ||
      left.startTimeMs - right.startTimeMs ||
      left.sequence - right.sequence ||
      left.cueId.localeCompare(right.cueId)
    ))
    .map(({ segmentSequence, ...cue }) => cue);
}

export function transcriptItemsFromSegments({ meeting, segments = [] } = {}) {
  const meetingId = meeting?.id;
  if (!meetingId || !Array.isArray(segments)) {
    return [];
  }

  return sortedSegments(segments)
    .flatMap((segment) => durableChunksForSegment(segment, meetingId).map((chunk) => ({
      id: chunk.idempotencyKey || `meeting:${meetingId}:${segment.id}:${chunk.stream}:${chunk.sequence}`,
      meetingId,
      segmentId: segment.id,
      segmentSequence: segment.sequence,
      segmentStatus: segment.status,
      liveSessionId: segment.liveSessionId ?? null,
      stream: chunk.stream,
      status: 'final',
      text: String(chunk.text).trim(),
      sequence: chunk.sequence,
      startedAt: chunk.timestamp,
      finalizedAt: chunk.timestamp
    })))
    .sort(compareTranscriptItems);
}

function mapSegmentToDTO(segment) {
  const checkpointChunks = durableChunksForSegment(segment, segment.meetingId);
  const sourceChunkCount = checkpointChunks.filter((chunk) => chunk.stream === 'source').length;
  const translationChunkCount = checkpointChunks.filter((chunk) => chunk.stream === 'translation').length;

  return {
    id: segment.id,
    meetingId: segment.meetingId,
    sequence: segment.sequence,
    status: segment.status,
    startedAt: segment.startedAt ?? null,
    endedAt: segment.endedAt ?? null,
    durationMs: durationBetween(segment.startedAt, segment.endedAt),
    liveSessionId: segment.liveSessionId ?? null,
    settingsSnapshot: meetingSettingsSnapshotDTO(segment.settingsSnapshot),
    errorInfo: copyRecord(segment.errorInfo),
    checkpointUpdatedAt: segment.checkpoint?.updatedAt ?? null,
    transcriptSummary: {
      totalItems: checkpointChunks.length,
      sourceFinalCount: sourceChunkCount,
      translationFinalCount: translationChunkCount,
      hasTranscript: checkpointChunks.length > 0
    }
  };
}

function mapSegmentToTimelineItem(segment) {
  return {
    id: segment.id,
    sequence: segment.sequence,
    status: segment.status,
    startedAt: segment.startedAt ?? null,
    endedAt: segment.endedAt ?? null,
    durationMs: durationBetween(segment.startedAt, segment.endedAt),
    liveSessionId: segment.liveSessionId ?? null,
    settingsSnapshot: meetingSettingsSnapshotDTO(segment.settingsSnapshot),
    errorInfo: copyRecord(segment.errorInfo)
  };
}

function meetingSettingsSnapshotDTO(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  return {
    ...snapshot,
    glossaryEntries: Array.isArray(snapshot.glossaryEntries)
      ? snapshot.glossaryEntries.map((entry) => ({
        ...entry,
        replacementAliases: meetingGlossaryAliasesForTarget(entry?.replacementAliases, snapshot.targetLanguageCode)
      }))
      : [],
    privateGlossaryEntries: normalizePrivateGlossaryEntries(snapshot.privateGlossaryEntries, snapshot.targetLanguageCode)
  };
}

function normalizePrivateGlossaryEntries(entries, targetLanguageCode) {
  return Array.isArray(entries) ? entries.map((entry) => ({
    ...entry,
    replacementAliases: meetingGlossaryAliasesForTarget(entry?.replacementAliases, targetLanguageCode)
  })) : [];
}

function buildReadingContent(transcriptItems) {
  const sourceItems = transcriptItems.filter((item) => item.stream === 'source');
  const translationItems = transcriptItems.filter((item) => item.stream === 'translation');
  const sourceParagraphs = buildTranscriptArticleParagraphs(sourceItems);
  const translationParagraphs = buildTranscriptArticleParagraphs(translationItems);

  return {
    sourceTranscript: {
      kind: 'sourceTranscript',
      status: sourceParagraphs.length > 0 ? 'available' : 'empty',
      text: formatTranscriptArticleText(sourceItems),
      paragraphs: sourceParagraphs
    },
    translationArticle: {
      kind: 'translationArticle',
      status: translationParagraphs.length > 0 ? 'available' : 'empty',
      text: translationParagraphs.join('\n\n'),
      paragraphs: translationParagraphs
    }
  };
}

function buildSegmentSummary(segments) {
  const countsByStatus = {};
  for (const segment of segments) {
    countsByStatus[segment.status] = (countsByStatus[segment.status] ?? 0) + 1;
  }

  return {
    totalSegments: segments.length,
    countsByStatus,
    hasInterruptedSegments: Boolean(countsByStatus.interrupted),
    hasFailedSegments: Boolean(countsByStatus.failed)
  };
}

function summarizeTranscriptItems(items) {
  const sourceFinalCount = items.filter((item) => item.stream === 'source').length;
  const translationFinalCount = items.filter((item) => item.stream === 'translation').length;

  return {
    ...EMPTY_TRANSCRIPT_SUMMARY,
    totalItems: items.length,
    sourceFinalCount,
    translationFinalCount,
    hasTranscript: items.length > 0
  };
}

function durableChunksForSegment(segment, meetingId) {
  if (!segment || segment.meetingId !== meetingId || !Number.isInteger(segment.sequence)) {
    return [];
  }

  const chunks = segment.checkpoint?.durableChunks;
  if (!Array.isArray(chunks)) {
    return [];
  }

  return chunks
    .filter((chunk) => validCheckpointChunk(chunk, meetingId, segment.id))
    .sort(compareChunks);
}

function validCheckpointChunk(chunk, meetingId, segmentId) {
  return chunk &&
    chunk.meetingId === meetingId &&
    chunk.segmentId === segmentId &&
    (chunk.stream === 'source' || chunk.stream === 'translation') &&
    Number.isInteger(chunk.sequence) &&
    chunk.sequence >= 0 &&
    typeof chunk.text === 'string' &&
    chunk.text.trim().length > 0 &&
    (typeof chunk.timestamp === 'string' || typeof chunk.timestamp === 'number');
}

function sortedSegments(segments) {
  return [...(Array.isArray(segments) ? segments : [])].sort(compareSegments);
}

function compareSegments(left, right) {
  return left.sequence - right.sequence ||
    compareTimestamps(left.startedAt, right.startedAt) ||
    compareTimestamps(left.createdAt, right.createdAt) ||
    left.id.localeCompare(right.id);
}

function compareChunks(left, right) {
  return streamOrder(left.stream) - streamOrder(right.stream) ||
    left.sequence - right.sequence ||
    String(left.idempotencyKey).localeCompare(String(right.idempotencyKey));
}

function compareTranscriptItems(left, right) {
  return left.segmentSequence - right.segmentSequence ||
    timestampValue(left.startedAt) - timestampValue(right.startedAt) ||
    streamOrder(left.stream) - streamOrder(right.stream) ||
    left.sequence - right.sequence ||
    left.id.localeCompare(right.id);
}

function streamOrder(stream) {
  return stream === 'source' ? 0 : 1;
}

function compareTimestamps(left, right) {
  return timestampValue(left) - timestampValue(right);
}

function timestampValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function firstFiniteTimestamp(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && timestampValue(value) !== Number.MAX_SAFE_INTEGER) {
      return value;
    }
  }

  return null;
}

function latestEndedAt(segments) {
  const values = segments
    .map((segment) => segment.endedAt)
    .filter((value) => value !== null && value !== undefined && timestampValue(value) !== Number.MAX_SAFE_INTEGER)
    .sort((left, right) => timestampValue(right) - timestampValue(left));

  return values[0] ?? null;
}

function durationBetween(startedAt, endedAt) {
  const start = timestampValue(startedAt);
  const end = timestampValue(endedAt);
  if (start === Number.MAX_SAFE_INTEGER || end === Number.MAX_SAFE_INTEGER || end < start) {
    return null;
  }

  return end - start;
}

function copyRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : null;
}
