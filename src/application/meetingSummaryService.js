const DEFAULT_MAX_CUES_PER_CHUNK = 40;
const DEFAULT_MAX_CHARACTERS_PER_CHUNK = 12000;

export function createMeetingSummaryService({
  finalCueRepository,
  summaryProvider,
  maxCuesPerChunk = DEFAULT_MAX_CUES_PER_CHUNK,
  maxCharactersPerChunk = DEFAULT_MAX_CHARACTERS_PER_CHUNK
} = {}) {
  assertMethod(finalCueRepository, 'listFinalCuesByMeeting', 'finalCueRepository');
  assertMethod(summaryProvider, 'summarizeChunk', 'summaryProvider');
  assertPositiveInteger(maxCuesPerChunk, 'maxCuesPerChunk');
  assertPositiveInteger(maxCharactersPerChunk, 'maxCharactersPerChunk');

  return Object.freeze({
    async generate({ meetingId } = {}) {
      assertNonEmptyString(meetingId, 'meetingId');
      const cues = await finalCueRepository.listFinalCuesByMeeting(meetingId);
      if (!Array.isArray(cues) || cues.length === 0) {
        const error = new Error(`Final Subtitle Cues are not available for meeting ${meetingId}.`);
        error.code = 'meeting_summary_cues_unavailable';
        throw error;
      }

      const orderedCues = cues.map(clone).sort(compareCues);
      const chunks = chunkFinalCues(orderedCues, { maxCuesPerChunk, maxCharactersPerChunk });
      const chunkSummaries = [];

      for (const [chunkIndex, chunk] of chunks.entries()) {
        chunkSummaries.push(await summaryProvider.summarizeChunk({
          meetingId,
          chunkIndex,
          totalChunks: chunks.length,
          cues: clone(chunk)
        }));
      }

      return Object.freeze({
        meetingId,
        cueCount: orderedCues.length,
        chunkCount: chunkSummaries.length,
        chunks: Object.freeze(chunkSummaries.map(clone)),
        summary: mergeChunkSummaries(chunkSummaries)
      });
    },
    async generatePartial({ sessionId, meetingId, range } = {}) {
      assertNonEmptyString(sessionId, 'sessionId');
      assertNonEmptyString(meetingId, 'meetingId');
      const cues = await finalCueRepository.listFinalCuesByMeeting(meetingId);
      const selected = cues.filter((cue) => cue.sessionId === sessionId && cue.segmentId === range?.segmentId);
      const orderedCues = selected.map(clone).sort(compareCues);
      if (!orderedCues.length || orderedCues[0].cueId !== range.startCueId || orderedCues.at(-1).cueId !== range.endCueId) throw coded('meeting_summary_range_unavailable', `Final Subtitle Cue range is not available: ${range?.rangeKey}`);
      const result = await summaryProvider.summarizeChunk({ meetingId, sessionId, chunkIndex: range.segmentSequence, totalChunks: null, range: clone(range), cues: clone(orderedCues) });
      return Object.freeze({ meetingId, sessionId, range: clone(range), cueCount: orderedCues.length, chunkCount: 1, chunks: Object.freeze([clone(result)]), summary: mergeChunkSummaries([result]) });
    },
    async listFinalCueRanges({ sessionId, meetingId } = {}) {
      assertNonEmptyString(sessionId, 'sessionId');
      assertNonEmptyString(meetingId, 'meetingId');
      const cues = (await finalCueRepository.listFinalCuesByMeeting(meetingId)).filter((cue) => cue.sessionId === sessionId).sort(compareCues);
      const groups = new Map();
      for (const cue of cues) {
        const key = `${cue.segmentSequence}:${cue.segmentId}`;
        const group = groups.get(key) || { segmentId: cue.segmentId, segmentSequence: cue.segmentSequence, cues: [] };
        group.cues.push(cue);
        groups.set(key, group);
      }
      return [...groups.values()].sort((left, right) => left.segmentSequence - right.segmentSequence).map((group) => ({
        segmentId: group.segmentId, segmentSequence: group.segmentSequence,
        startCueId: group.cues[0].cueId, endCueId: group.cues.at(-1).cueId,
        rangeKey: `${group.segmentSequence}:${group.segmentId}:${group.cues[0].cueId}:${group.cues.at(-1).cueId}`
      }));
    }
  });
}

export function createFinalCueSummaryTrigger({ summaryService } = {}) {
  assertMethod(summaryService, 'generate', 'summaryService');

  return Object.freeze({
    async onFinalCuesFinalized({ meetingId } = {}) {
      return summaryService.generate({ meetingId });
    }
  });
}

export function chunkFinalCues(cues, { maxCuesPerChunk = DEFAULT_MAX_CUES_PER_CHUNK, maxCharactersPerChunk = DEFAULT_MAX_CHARACTERS_PER_CHUNK } = {}) {
  if (!Array.isArray(cues)) throw new TypeError('cues must be an array.');
  assertPositiveInteger(maxCuesPerChunk, 'maxCuesPerChunk');
  assertPositiveInteger(maxCharactersPerChunk, 'maxCharactersPerChunk');

  const chunks = [];
  let current = [];
  let currentCharacters = 0;

  for (const cue of cues) {
    const cueCharacters = cueText(cue).length;
    const wouldExceedCount = current.length >= maxCuesPerChunk;
    const wouldExceedCharacters = current.length > 0 && currentCharacters + cueCharacters > maxCharactersPerChunk;
    if (current.length > 0 && (wouldExceedCount || wouldExceedCharacters)) {
      chunks.push(current);
      current = [];
      currentCharacters = 0;
    }
    current.push(cue);
    currentCharacters += cueCharacters;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function mergeChunkSummaries(summaries) {
  if (!Array.isArray(summaries)) throw new TypeError('summaries must be an array.');
  const normalized = summaries.map(normalizeSummary);
  return Object.freeze({
    title: normalized.find((summary) => summary.title)?.title || 'Meeting Summary',
    overview: normalized.map((summary) => summary.overview).filter(Boolean).join('\n\n'),
    keyPoints: uniqueInOrder(normalized.flatMap((summary) => summary.keyPoints)),
    decisions: uniqueInOrder(normalized.flatMap((summary) => summary.decisions)),
    actionItems: uniqueInOrder(normalized.flatMap((summary) => summary.actionItems))
  });
}

function normalizeSummary(summary = {}) {
  return {
    title: cleanString(summary.title),
    overview: cleanString(summary.overview),
    keyPoints: cleanStringArray(summary.keyPoints),
    decisions: cleanStringArray(summary.decisions),
    actionItems: cleanStringArray(summary.actionItems)
  };
}

function compareCues(left, right) {
  return String(left.segmentSequence ?? '').localeCompare(String(right.segmentSequence ?? ''), undefined, { numeric: true }) ||
    numberCompare(left.startTimeMs, right.startTimeMs) ||
    numberCompare(left.endTimeMs, right.endTimeMs) ||
    numberCompare(left.sequence, right.sequence) ||
    String(left.cueId).localeCompare(String(right.cueId));
}

function cueText(cue) {
  return JSON.stringify(cue);
}

function uniqueInOrder(values) {
  return [...new Set(values)];
}

function cleanString(value) { return typeof value === 'string' ? value.trim() : ''; }
function cleanStringArray(value) { return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : []; }
function numberCompare(left, right) { return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function assertMethod(value, method, name) { if (!value || typeof value[method] !== 'function') throw new TypeError(`${name}.${method} must be a function.`); }
function assertNonEmptyString(value, name) { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string.`); }
function assertPositiveInteger(value, name) { if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`); }
function coded(code, message) { const error = new Error(message); error.code = code; error.retryable = true; return error; }
