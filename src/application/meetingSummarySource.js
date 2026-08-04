import { createHash } from 'node:crypto';

export const MEETING_SUMMARY_SOURCE_SCHEMA_VERSION = 1;

export function buildMeetingSummarySource({ cues = [], transcriptItems = [] } = {}) {
  const hasCues = Array.isArray(cues) && cues.length > 0;
  const sourceType = hasCues ? 'final_cues' : 'legacy_transcript';
  const candidates = hasCues ? cues : legacyItemsToCues(transcriptItems);
  const normalized = normalizeCandidates(candidates, { sourceType });
  if (normalized.length === 0) {
    const error = new Error('Meeting summary source is empty.');
    error.code = 'meeting_summary_source_empty';
    throw error;
  }

  const sourceText = normalized.map((cue) => cue.sourceText).join('\n\n');
  const source = {
    schemaVersion: MEETING_SUMMARY_SOURCE_SCHEMA_VERSION,
    sourceType,
    sourceCueCount: normalized.length,
    sourceCharacterCount: sourceText.length,
    sourceHash: hashSource({ sourceType, cues: normalized.map(toHashCue) }),
    sourceText,
    cues: normalized.map(toProviderCue)
  };
  return Object.freeze({ ...source, cues: Object.freeze(source.cues) });
}

function normalizeCandidates(candidates, { sourceType }) {
  const byId = new Map();
  for (const [index, candidate] of candidates.entries()) {
    const sourceText = String(candidate?.sourceText ?? candidate?.text ?? '').trim();
    if (!sourceText || /^[\s\p{P}\p{S}]+$/u.test(sourceText)) continue;
    const cue = {
      cueId: String(candidate?.cueId ?? `${sourceType}:${index}`),
      segmentId: candidate?.segmentId ?? null,
      segmentSequence: Number.isInteger(candidate?.segmentSequence) ? candidate.segmentSequence : 0,
      sequence: Number.isInteger(candidate?.sequence) ? candidate.sequence : index,
      startTimeMs: Number.isFinite(candidate?.startTimeMs) ? candidate.startTimeMs : null,
      endTimeMs: Number.isFinite(candidate?.endTimeMs) ? candidate.endTimeMs : null,
      sourceText
    };
    const existing = byId.get(cue.cueId);
    if (existing && JSON.stringify(toHashCue(existing)) !== JSON.stringify(toHashCue(cue))) {
      const error = new Error(`Meeting summary source Cue conflicts: ${cue.cueId}`);
      error.code = 'meeting_summary_source_conflict';
      throw error;
    }
    byId.set(cue.cueId, cue);
  }
  return [...byId.values()].sort(compareCues);
}

function legacyItemsToCues(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.status === 'final' && (item.stream === 'source' || item.stream === undefined))
    .map((item, index) => ({
      cueId: item.id ?? `legacy:${index}`,
      sequence: Number.isInteger(item.sequence) ? item.sequence : index,
      startTimeMs: item.startedAt,
      endTimeMs: item.finalizedAt,
      sourceText: item.text
    }));
}

function toProviderCue(cue) {
  return { sourceText: cue.sourceText, startTimeMs: cue.startTimeMs, endTimeMs: cue.endTimeMs };
}

function toHashCue(cue) {
  return {
    cueId: cue.cueId,
    segmentId: cue.segmentId,
    segmentSequence: cue.segmentSequence,
    sequence: cue.sequence,
    startTimeMs: cue.startTimeMs,
    endTimeMs: cue.endTimeMs,
    sourceText: cue.sourceText
  };
}

function hashSource(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function compareCues(left, right) { return left.segmentSequence - right.segmentSequence || numberCompare(left.startTimeMs, right.startTimeMs) || numberCompare(left.sequence, right.sequence) || left.cueId.localeCompare(right.cueId); }
function numberCompare(left, right) { return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0); }
