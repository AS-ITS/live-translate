const MIN_CUE_DURATION_MS = 300;

export const DEFAULT_SUBTITLE_RESEGMENT_MAX_CUES = 12;
export const DEFAULT_SUBTITLE_RESEGMENT_MAX_TEXT_LENGTH = 1200;

export function stableSubtitleGroup(cues = [], options = {}) {
  const maxCues = options.maxCues ?? DEFAULT_SUBTITLE_RESEGMENT_MAX_CUES;
  const maxTextLength = options.maxTextLength ?? DEFAULT_SUBTITLE_RESEGMENT_MAX_TEXT_LENGTH;
  const ordered = [...(Array.isArray(cues) ? cues : [])]
    .filter((cue) => cue?.status === 'final' && cue?.cueId && meaningful(cue.rawSource ?? cue.sourceText) && meaningful(cue.rawTranslation ?? cue.translatedText))
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const group = [];
  let length = 0;
  for (const cue of ordered) {
    const nextLength = length + text(cue.rawSource ?? cue.sourceText).length + text(cue.rawTranslation ?? cue.translatedText).length;
    if (group.length >= maxCues || (group.length > 0 && nextLength > maxTextLength)) break;
    group.push(cue);
    length = nextLength;
  }
  return group;
}

export function subtitleResegmentationInputHash(cues = []) {
  return fnv(JSON.stringify(stableSubtitleGroup(cues).map((cue) => ({
    cueId: cue.cueId,
    sequence: cue.sequence,
    rawSource: text(cue.rawSource ?? cue.sourceText),
    rawTranslation: text(cue.rawTranslation ?? cue.translatedText)
  }))));
}

export function validateSubtitleResegmentationResponse(response, cues = []) {
  const expected = stableSubtitleGroup(cues);
  if (!Array.isArray(response?.refinedCues) || response.refinedCues.length === 0) {
    throw invalid('refinedCues must be a non-empty array');
  }
  const allowed = new Map(expected.map((cue) => [cue.cueId, cue]));
  const seen = new Set();
  let lastSequence = -Infinity;
  const result = response.refinedCues.map((item) => {
    if (!Array.isArray(item?.sourceCueIds) || item.sourceCueIds.length === 0) throw invalid('sourceCueIds must be non-empty');
    const sources = item.sourceCueIds.map((id) => allowed.get(id));
    if (sources.some((cue) => !cue) || item.sourceCueIds.some((id) => seen.has(id))) throw invalid('unknown or duplicate sourceCueIds');
    item.sourceCueIds.forEach((id) => seen.add(id));
    const sequence = Math.min(...sources.map((cue) => cue.sequence));
    if (sequence <= lastSequence) throw invalid('refinedCues order is invalid');
    lastSequence = sequence;
    if (!meaningful(item.refinedSource) || !meaningful(item.refinedTranslation)) throw invalid('refined cue text must be non-empty');
    return {
      sourceCueIds: [...item.sourceCueIds],
      refinedSource: text(item.refinedSource),
      refinedTranslation: text(item.refinedTranslation),
      sequence
    };
  });
  if (seen.size !== expected.length || expected.some((cue) => !seen.has(cue.cueId))) throw invalid('refinedCues must cover the complete input group');
  return result;
}

export function allocateSubtitleResegmentedCueTimes(cues = [], refinedCues = [], options = {}) {
  const source = stableSubtitleGroup(cues);
  const validated = validateSubtitleResegmentationResponse({ refinedCues }, source);
  if (source.length === 0) return [];
  const start = Math.min(...source.map((cue) => cue.startTimeMs));
  const end = Math.max(...source.map((cue) => cue.endTimeMs));
  const total = Math.max(0, end - start);
  const weights = validated.map((cue) => Math.max(1, cue.refinedSource.length + cue.refinedTranslation.length));
  const minDuration = options.minimumCueDurationMs ?? MIN_CUE_DURATION_MS;
  let segments = validated.map((cue) => ({ ...cue, weight: Math.max(1, cue.refinedSource.length + cue.refinedTranslation.length) }));
  while (segments.length > 1 && total < minDuration * segments.length) {
    const index = segments.findIndex((_, itemIndex) => itemIndex < segments.length - 1);
    const next = segments[index + 1];
    segments[index] = {
      ...segments[index],
      sourceCueIds: [...segments[index].sourceCueIds, ...next.sourceCueIds],
      refinedSource: `${segments[index].refinedSource} ${next.refinedSource}`.trim(),
      refinedTranslation: `${segments[index].refinedTranslation} ${next.refinedTranslation}`.trim(),
      weight: segments[index].weight + next.weight
    };
    segments.splice(index + 1, 1);
  }
  const boundaries = distributeDurations(total, segments.map((cue) => cue.weight), minDuration);
  const groupHash = options.groupHash || subtitleResegmentationInputHash(source);
  return segments.map((cue, index) => ({
    cueId: `refined-subtitle:${groupHash}:${index}`,
    sourceCueIds: [...cue.sourceCueIds],
    sequence: cue.sequence,
    startTimeMs: start + boundaries[index].start,
    endTimeMs: start + boundaries[index].end,
    sourceLanguageCode: source.find((item) => cue.sourceCueIds.includes(item.cueId))?.sourceLanguageCode,
    targetLanguageCode: source.find((item) => cue.sourceCueIds.includes(item.cueId))?.targetLanguageCode,
    sourceText: cue.refinedSource,
    translatedText: cue.refinedTranslation,
    rawSource: cue.refinedSource,
    rawTranslation: cue.refinedTranslation,
    status: 'final',
    revision: options.revision ?? 1,
    refinement: { status: 'completed', inputHash: groupHash, version: options.revision ?? 1 }
  }));
}

function distributeDurations(total, weights, minimum) {
  if (weights.length === 1) return [{ start: 0, end: total }];
  const effectiveMinimum = total >= minimum * weights.length ? minimum : 0;
  const remaining = total - effectiveMinimum * weights.length;
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  return weights.map((weight, index) => {
    const start = cursor;
    const duration = index === weights.length - 1
      ? total - cursor
      : effectiveMinimum + Math.floor(remaining * weight / weightTotal);
    cursor += duration;
    return { start, end: cursor };
  });
}

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function meaningful(value) { return /[^\s\p{P}\p{S}]/u.test(text(value)); }
function fnv(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
function invalid(detail) { return Object.assign(new TypeError(`provider_invalid_response: ${detail}`), { code: 'provider_invalid_response' }); }
