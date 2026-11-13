import { cueRefinementInputHash, effectiveTranslationForCue, hasCurrentRefinementBinding } from './cueContent.js';

export function applyGlossaryReplacements(text, glossaryEntries = []) {
  return glossaryReplacementForText(text, glossaryEntries).text;
}

export function glossaryReplacementForText(text, glossaryEntries = []) {
  if (typeof text !== 'string' || !Array.isArray(glossaryEntries) || glossaryEntries.length === 0) {
    return { text, status: 'not_applicable' };
  }
  const candidates = glossaryEntries.flatMap((entry) => replacementCandidatesForEntry(entry));
  let result = '';
  let ambiguous = false;
  let changed = false;
  for (let index = 0; index < text.length;) {
    const matches = candidates.filter(({ from }) =>
      comparableText(text.slice(index, index + from.length)) === comparableText(from)
      && hasSourceBoundaries(text, from, index));
    if (matches.length === 0) {
      result += text[index++];
      continue;
    }
    const longest = Math.max(...matches.map(({ from }) => from.length));
    const winners = matches.filter(({ from }) => from.length === longest);
    const targets = new Set(winners.map(({ to }) => to));
    if (targets.size > 1) ambiguous = true;
    else changed = true;
    result += targets.size > 1 ? text.slice(index, index + longest) : winners[0].to;
    index += longest;
  }
  return { text: result, status: ambiguous ? 'correction_ambiguous' : changed ? 'corrected' : 'not_applicable' };
}

export function correctTranslationForSource({ sourceText, translatedText } = {}, glossaryEntries = []) {
  return glossaryCorrectionForSource({ sourceText, translatedText }, glossaryEntries).translatedText;
}

export function glossaryCorrectionForSource({ sourceText, translatedText } = {}, glossaryEntries = [], { onDiagnostic } = {}) {
  if (typeof sourceText !== 'string' || typeof translatedText !== 'string' || !Array.isArray(glossaryEntries)) {
    return { translatedText, status: 'not_applicable', occurrences: [] };
  }
  if (glossaryEntries.some((entry) => !entry || typeof entry.source !== 'string'
    || !entry.source.trim() || typeof entry.target !== 'string' || !entry.target.trim()
    || (entry.replacementAliases !== undefined
      && (!Array.isArray(entry.replacementAliases)
        || entry.replacementAliases.some((alias) => typeof alias !== 'string'))))) {
    return { translatedText, status: 'not_applicable', occurrences: [] };
  }

  const sentence = comparableText(sourceText).trim().replace(/\p{P}+$/gu, '').trim();
  const fullMatches = sentence && !/[\p{P}\s]/u.test(sentence) && glossaryEntries.filter((entry) =>
    comparableText(entry.source).trim().replace(/\p{P}+$/gu, '').trim() === sentence
  );
  if (fullMatches?.length === 1) {
    const corrected = fullMatches[0].target.trim();
    onDiagnostic?.({ sourceMatchCount: 1, alignmentCandidateCount: 1,
      correctionStatus: corrected === translatedText ? 'unchanged' : 'corrected',
      reasonCode: 'full_source_match' });
    return { translatedText: corrected, status: corrected === translatedText ? 'unchanged' : 'corrected',
      occurrences: [{ start: 0, end: sourceText.length, entryOrder: glossaryEntries.indexOf(fullMatches[0]),
        source: fullMatches[0].source, target: corrected }] };
  }
  if (fullMatches?.length > 1) {
    onDiagnostic?.({ sourceMatchCount: fullMatches.length, alignmentCandidateCount: 0,
      correctionStatus: 'correction_ambiguous', reasonCode: 'source_target_conflict' });
    return { translatedText, status: 'correction_ambiguous', occurrences: [] };
  }

  const { occurrences, ambiguous } = matchSourceOccurrences(sourceText, glossaryEntries);
  if (occurrences.length === 0) {
    onDiagnostic?.({ sourceMatchCount: 0, alignmentCandidateCount: 0,
      correctionStatus: ambiguous ? 'correction_ambiguous' : 'not_applicable',
      reasonCode: ambiguous ? 'source_target_conflict' : 'no_source_match' });
    return { translatedText, status: ambiguous ? 'correction_ambiguous' : 'not_applicable', occurrences: [] };
  }

  const { text: corrected, uncertain, ambiguous: targetAmbiguous, candidateCount } = replaceAlignedTranslation(translatedText, occurrences, glossaryEntries);
  const status = ambiguous || targetAmbiguous ? 'correction_ambiguous'
    : uncertain ? 'correction_uncertain' : corrected === translatedText ? 'unchanged' : 'corrected';
  onDiagnostic?.({ sourceMatchCount: occurrences.length, alignmentCandidateCount: candidateCount,
    correctionStatus: status, reasonCode: ambiguous ? 'source_target_conflict'
      : targetAmbiguous ? 'alignment_conflict' : uncertain ? 'alignment_count_mismatch' : null });
  return {
    translatedText: corrected,
    status,
    occurrences
  };
}

export function applyGlossaryCorrectionsToCueState(state, glossaryEntries = [], { entriesForCue } = {}) {
  if (!state || (!Array.isArray(glossaryEntries) && typeof entriesForCue !== 'function')) return state;
  if (glossaryEntries.length === 0 && typeof entriesForCue !== 'function') return state;
  let changed = false;
  const correct = (cue) => {
    const cueEntries = typeof entriesForCue === 'function'
      ? entriesForCue(cue)
      : glossaryEntries;
    const next = applyGlossaryCorrectionToCue(cue, cueEntries);
    if (next !== cue) changed = true;
    return next;
  };
  const finalCues = (state.finalCues || []).map(correct);
  const refinedSubtitleCues = (state.refinedSubtitleCues || []).map(correct);
  return changed ? { ...state, finalCues, refinedSubtitleCues } : state;
}

export function applyGlossaryCorrectionToCue(cue, glossaryEntries = [], { refineOnly = false } = {}) {
  if (!cue || cue.status !== 'final') return cue;
  // Legacy Local Cues without Live version evidence remain readable, but cannot gain invented refinement provenance.
  if (!Number.isSafeInteger(cue.translationVersion) || cue.translationVersion < 1
    || !cue.translationProvenance || !Number.isSafeInteger(cue.translationProvenance.eventSequence)
    || !Number.isSafeInteger(cue.translationProvenance.connectionEpoch)
    || !Number.isSafeInteger(cue.translationProvenance.providerEpoch)
    || !cue.initialTranslation) return cue;
  const sourceText = cue.rawSource ?? cue.sourceText ?? '';
  const providerTranslation = cue.rawTranslation ?? cue.translatedText ?? '';
  const initialCorrection = glossaryCorrectionForSource(
    { sourceText, translatedText: providerTranslation },
    glossaryEntries
  );
  const currentHash = cueRefinementInputHash(cue);
  const validRefined = hasCurrentRefinementBinding(cue);
  const refinedCorrection = validRefined
    ? glossaryCorrectionForSource({ sourceText, translatedText: cue.refinedTranslation }, glossaryEntries)
    : null;
  const refinedTranslation = refinedCorrection?.translatedText ?? initialCorrection.translatedText;
  const glossaryCorrectionStatus = [initialCorrection.status, refinedCorrection?.status]
    .includes('correction_ambiguous') ? 'correction_ambiguous'
    : [initialCorrection.status, refinedCorrection?.status].includes('correction_uncertain')
      ? 'correction_uncertain'
    : initialCorrection.status;
  const refinedChanged = refinedCorrection
    ? refinedTranslation !== cue.refinedTranslation
    : !refineOnly && refinedTranslation !== providerTranslation;
  const statusChanged = glossaryCorrectionStatus !== cue.glossaryCorrectionStatus;
  if (!refinedChanged && !statusChanged) return cue;
  return {
    ...cue,
    ...(refinedChanged ? {
      refinedTranslation,
      refinement: {
        ...(cue.refinement || {}),
        status: 'completed',
        version: (cue.refinement?.version || 0) + 1,
        inputHash: currentHash
      }
    } : {}),
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
  let ambiguous = false;

  for (let index = 0; index < source.length;) {
    const matches = entries.filter((candidate) => (
      source.startsWith(candidate.source, index)
      && hasSourceBoundaries(source, candidate.source, index)
    ));
    if (matches.length === 0) {
      index += 1;
      continue;
    }
    const longest = matches[0].source.length;
    const winners = matches.filter((candidate) => candidate.source.length === longest);
    if (new Set(winners.map((candidate) => candidate.target)).size > 1) {
      ambiguous = true;
      index += longest;
      continue;
    }
    const match = winners[0];
    occurrences.push({
      start: index,
      end: index + match.source.length,
      entryOrder: match.order,
      source: match.entry.source,
      target: match.target
    });
    index += match.source.length;
  }
  return { occurrences, ambiguous };
}

function hasSourceBoundaries(source, term, index) {
  if (containsCjk(term)) return true;
  const before = source[index - 1] || '';
  const after = source[index + term.length] || '';
  return (!before || !/[\p{L}\p{N}]/u.test(before))
    && (!after || !/[\p{L}\p{N}]/u.test(after));
}

function replaceAlignedTranslation(translation, occurrences, glossaryEntries) {
  const counts = new Map();
  for (const occurrence of occurrences) {
    counts.set(occurrence.entryOrder, (counts.get(occurrence.entryOrder) || 0) + 1);
  }
  const matches = [];
  for (const [order] of counts) {
    const entry = glossaryEntries[order];
    const aliases = Array.isArray(entry.replacementAliases) ? entry.replacementAliases : [];
    const candidates = [entry.source, ...aliases, entry.target]
      .filter((value) => typeof value === 'string' && value.length > 0);
    for (const candidate of new Set(candidates)) {
      const targetAlreadyPresent = comparableText(candidate) === comparableText(entry.target);
      const pattern = containsCjk(candidate)
        ? new RegExp(escapeRegExp(candidate), 'giu')
        : new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(candidate)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
      for (const match of translation.matchAll(pattern)) {
        const start = match.index + (containsCjk(candidate) ? 0 : match[1].length);
        matches.push({ start, end: start + candidate.length, order, target: entry.target, targetAlreadyPresent });
      }
    }
  }
  matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.order - b.order);
  const selected = [];
  let ambiguous = false;
  for (const match of matches) {
    if (selected.length && match.start < selected.at(-1).end) continue;
    const sameRange = matches.filter((candidate) => candidate.start === match.start && candidate.end === match.end);
    const aliases = sameRange.filter((candidate) => !candidate.targetAlreadyPresent);
    const aliasTargets = new Set(aliases.map((candidate) => candidate.target));
    if (aliasTargets.size > 1) {
      ambiguous = true;
      selected.push({ ...match, ambiguous: true });
      continue;
    }
    const protective = sameRange.filter((candidate) => candidate.targetAlreadyPresent && candidate.order !== aliases[0]?.order);
    const unresolvedProtection = protective.some((candidate) => !matches.some((other) =>
      other.order === candidate.order && !other.targetAlreadyPresent
      && (other.start !== match.start || other.end !== match.end)));
    if (aliases.length && unresolvedProtection) {
      ambiguous = true;
      selected.push({ ...match, ambiguous: true });
      continue;
    }
    selected.push(aliases[0] || sameRange[0]);
  }
  const seen = new Map();
  for (const match of selected) {
    if (!match.ambiguous) seen.set(match.order, (seen.get(match.order) || 0) + 1);
  }
  const unsafe = new Set([...counts].filter(([order]) => (seen.get(order) || 0) > counts.get(order)).map(([order]) => order));
  let uncertain = false;
  for (const [order] of counts) {
    if ((seen.get(order) || 0) !== counts.get(order) || unsafe.has(order)) uncertain = true;
  }
  let cursor = 0;
  let text = '';
  for (const match of selected) {
    text += translation.slice(cursor, match.start);
    text += match.ambiguous || match.targetAlreadyPresent || unsafe.has(match.order)
      ? translation.slice(match.start, match.end) : match.target;
    cursor = match.end;
  }
  return { text: text + translation.slice(cursor), uncertain, ambiguous, candidateCount: selected.length };
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
