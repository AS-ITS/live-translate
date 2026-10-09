export function applyGlossaryReplacements(text, glossaryEntries = []) {
  if (typeof text !== 'string' || text.length === 0 || !Array.isArray(glossaryEntries) || glossaryEntries.length === 0) {
    return text;
  }

  const replacements = glossaryEntries
    .flatMap((entry) => replacementCandidatesForEntry(entry))
    .filter((replacement, index, all) => all.findIndex((candidate) => candidate.from === replacement.from && candidate.to === replacement.to) === index)
    .sort((left, right) => right.from.length - left.from.length);

  return replacements.reduce(
    (current, replacement) => current.split(replacement.from).join(replacement.to),
    text
  );
}

export function correctTranslationForSource({ sourceText, translatedText } = {}, glossaryEntries = []) {
  return glossaryCorrectionForSource({ sourceText, translatedText }, glossaryEntries).translatedText;
}

export function glossaryCorrectionForSource({ sourceText, translatedText } = {}, glossaryEntries = []) {
  if (typeof sourceText !== 'string' || typeof translatedText !== 'string' || !Array.isArray(glossaryEntries)) {
    return { translatedText, status: 'not_applicable', occurrences: [] };
  }

  const occurrences = matchSourceOccurrences(sourceText, glossaryEntries);
  if (occurrences.length === 0) {
    return { translatedText, status: 'not_applicable', occurrences: [] };
  }

  if (!sourceIsFullyCovered(sourceText, occurrences)) {
    return { translatedText, status: 'correction_uncertain', occurrences };
  }

  const corrected = renderCoveredGlossaryTranslation(sourceText, translatedText, occurrences);
  return {
    translatedText: corrected,
    status: corrected === translatedText ? 'unchanged' : 'corrected',
    occurrences
  };
}

export function applyGlossaryCorrectionsToCueState(state, glossaryEntries = []) {
  if (!state || !Array.isArray(glossaryEntries) || glossaryEntries.length === 0) return state;
  let changed = false;
  const correct = (cue) => {
    const next = applyGlossaryCorrectionToCue(cue, glossaryEntries);
    if (next !== cue) changed = true;
    return next;
  };
  const finalCues = (state.finalCues || []).map(correct);
  const refinedSubtitleCues = (state.refinedSubtitleCues || []).map(correct);
  return changed ? { ...state, finalCues, refinedSubtitleCues } : state;
}

export function applyGlossaryCorrectionToCue(cue, glossaryEntries = []) {
  if (!cue || cue.status !== 'final') return cue;
  const sourceText = cue.rawSource ?? cue.sourceText ?? '';
  const providerTranslation = cue.rawTranslation ?? cue.translatedText ?? '';
  const initialCorrection = glossaryCorrectionForSource(
    { sourceText, translatedText: providerTranslation },
    glossaryEntries
  );
  const initialTranslation = initialCorrection.translatedText;
  const refinedCorrection = typeof cue.refinedTranslation === 'string'
    ? glossaryCorrectionForSource({ sourceText, translatedText: cue.refinedTranslation }, glossaryEntries)
    : null;
  const refinedTranslation = refinedCorrection?.translatedText ?? cue.refinedTranslation;
  const glossaryCorrectionStatus = [initialCorrection.status, refinedCorrection?.status]
    .includes('correction_uncertain')
    ? 'correction_uncertain'
    : initialCorrection.status;
  const initialChanged = (
    initialCorrection.status !== 'not_applicable'
    || typeof cue.initialTranslation === 'string'
  ) && initialTranslation !== cue.initialTranslation;
  const refinedChanged = refinedTranslation !== cue.refinedTranslation;
  const statusChanged = glossaryCorrectionStatus !== cue.glossaryCorrectionStatus;
  if (!initialChanged && !refinedChanged && !statusChanged) return cue;
  return {
    ...cue,
    ...(initialChanged ? { initialTranslation } : {}),
    ...(refinedChanged ? { refinedTranslation } : {}),
    glossaryCorrectionStatus
  };
}

function replacementCandidatesForEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.target !== 'string' || entry.target.length === 0) {
    return [];
  }

  const aliases = Array.isArray(entry.replacementAliases) ? entry.replacementAliases : [];
  return [entry.source, ...aliases]
    .filter((candidate) => typeof candidate === 'string' && candidate.length > 0)
    .filter((candidate) => candidate !== entry.target)
    .map((from) => ({ from, to: entry.target }));
}

function matchSourceOccurrences(sourceText, glossaryEntries) {
  const source = comparableText(sourceText);
  const entries = glossaryEntries
    .map((entry, order) => ({
      entry,
      order,
      source: comparableText(entry?.source),
      target: typeof entry?.target === 'string' ? entry.target.trim() : ''
    }))
    .filter(({ source, target }) => source && target)
    .sort((left, right) => right.source.length - left.source.length || left.order - right.order);
  const occurrences = [];

  for (let index = 0; index < source.length;) {
    const match = entries.find((candidate) => (
      source.startsWith(candidate.source, index)
      && hasSourceBoundaries(source, candidate.source, index)
    ));
    if (!match) {
      index += 1;
      continue;
    }
    occurrences.push({
      start: index,
      end: index + match.source.length,
      source: match.entry.source,
      target: match.target
    });
    index += match.source.length;
  }
  return occurrences;
}

function hasSourceBoundaries(source, term, index) {
  if (containsCjk(term)) return true;
  const before = source[index - 1] || '';
  const after = source[index + term.length] || '';
  return (!before || !/[\p{L}\p{N}]/u.test(before))
    && (!after || !/[\p{L}\p{N}]/u.test(after));
}

function sourceIsFullyCovered(sourceText, occurrences) {
  const source = comparableText(sourceText);
  let cursor = 0;
  for (const occurrence of occurrences) {
    if (!isSeparatorOnly(source.slice(cursor, occurrence.start))) return false;
    cursor = occurrence.end;
  }
  return isSeparatorOnly(source.slice(cursor));
}

function renderCoveredGlossaryTranslation(sourceText, providerTranslation, occurrences) {
  const parts = [];
  let cursor = 0;
  occurrences.forEach((occurrence, index) => {
    const separator = sourceText.slice(cursor, occurrence.start);
    if (index === 0) parts.push(separator);
    else parts.push(separator || ', ');
    parts.push(occurrence.target);
    cursor = occurrence.end;
  });

  const sourceTrailing = sourceText.slice(cursor);
  const providerTrailing = terminalPunctuation(providerTranslation);
  const trailing = providerTrailing || sourceTrailing;
  const result = parts.join('');
  return `${stripDuplicateTerminalPunctuation(result, trailing)}${trailing}`;
}

function isSeparatorOnly(value) {
  return value === '' || /^[\s\p{P}\p{S}]*$/u.test(value);
}

function terminalPunctuation(value) {
  return value.match(/[\p{P}\p{S}]+\s*$/u)?.[0] || '';
}

function stripDuplicateTerminalPunctuation(value, trailing) {
  if (!trailing) return value;
  return value.replace(/[\p{P}\p{S}]+\s*$/u, '');
}

function comparableText(value) {
  return typeof value === 'string' ? value.normalize('NFKC').toLocaleLowerCase() : '';
}

function replaceScopedCandidate(value, candidate, target) {
  const replacement = typeof target === 'function'
    ? target
    : (_match, prefix = '') => `${prefix}${target}`;
  if (containsCjk(candidate)) {
    const pattern = new RegExp(escapeRegExp(candidate), 'gu');
    return value.replace(pattern, (match) => (
      typeof target === 'function' ? target(match, '') : target
    ));
  }
  const escaped = escapeRegExp(candidate);
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'giu');
  return value.replace(pattern, replacement);
}

function containsCjk(value) {
  return /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
