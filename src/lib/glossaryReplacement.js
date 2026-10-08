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
  if (typeof sourceText !== 'string' || typeof translatedText !== 'string' || !Array.isArray(glossaryEntries)) {
    return translatedText;
  }

  return glossaryEntries.reduce((current, entry, entryIndex) => {
    if (!sourceContainsTerm(sourceText, entry?.source)) return current;
    if (typeof entry?.target !== 'string' || entry.target.trim() === '') return current;

    const target = entry.target.trim();
    if (sourceEqualsTerm(sourceText, entry.source)) {
      return `${target}${trailingPunctuation(current)}`;
    }

    const candidates = [entry.source, ...(Array.isArray(entry.replacementAliases) ? entry.replacementAliases : [])]
      .filter((candidate) => typeof candidate === 'string' && candidate.trim() && candidate !== target)
      .sort((left, right) => right.length - left.length);

    const marker = `\uE000glossary-${entryIndex}\uE001`;
    const marked = candidates.reduce(
      (value, candidate) => replaceScopedCandidate(value, candidate, marker),
      current
    );
    return marked === current
      ? current
      : resolveMarkedAliases(marked, marker, target);
  }, translatedText);
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
  const initialTranslation = correctTranslationForSource(
    { sourceText, translatedText: providerTranslation },
    glossaryEntries
  );
  const correctedRefinedTranslation = typeof cue.refinedTranslation === 'string'
    ? correctTranslationForSource({ sourceText, translatedText: cue.refinedTranslation }, glossaryEntries)
    : cue.refinedTranslation;
  const refinedTranslation = shouldKeepInitialGlossaryTranslation({
    sourceText,
    initialTranslation,
    refinedTranslation: correctedRefinedTranslation,
    glossaryEntries
  }) ? initialTranslation : correctedRefinedTranslation;
  const initialChanged = initialTranslation !== providerTranslation;
  const refinedChanged = refinedTranslation !== cue.refinedTranslation;
  if (!initialChanged && !refinedChanged) return cue;
  return {
    ...cue,
    ...(initialChanged ? { initialTranslation } : {}),
    ...(refinedChanged ? { refinedTranslation } : {})
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

function sourceContainsTerm(sourceText, sourceTerm) {
  const source = comparableText(sourceText);
  const term = comparableText(sourceTerm);
  if (!source || !term) return false;
  if (containsCjk(term)) return source.includes(term);
  const escaped = escapeRegExp(term);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(source);
}

function sourceEqualsTerm(sourceText, sourceTerm) {
  return stripTerminalPunctuation(comparableText(sourceText)) === stripTerminalPunctuation(comparableText(sourceTerm));
}

function shouldKeepInitialGlossaryTranslation({ sourceText, initialTranslation, refinedTranslation, glossaryEntries }) {
  if (typeof initialTranslation !== 'string' || typeof refinedTranslation !== 'string') return false;
  const requiredEntries = glossaryEntries.filter((entry) => (
    sourceContainsTerm(sourceText, entry?.source)
    && typeof entry?.target === 'string'
    && entry.target.trim() !== ''
  ));
  return requiredEntries.length > 0
    && requiredEntries.every((entry) => containsLiteral(initialTranslation, entry.target))
    && requiredEntries.some((entry) => !containsLiteral(refinedTranslation, entry.target));
}

function comparableText(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().toLocaleLowerCase() : '';
}

function stripTerminalPunctuation(value) {
  return value.replace(/[\s\p{P}\p{S}]+$/gu, '');
}

function trailingPunctuation(value) {
  const match = value.match(/[\s\p{P}\p{S}]+$/u);
  return match?.[0] || '';
}

function containsLiteral(value, candidate) {
  return value.normalize('NFKC').toLocaleLowerCase().includes(candidate.normalize('NFKC').toLocaleLowerCase());
}

function resolveMarkedAliases(value, marker, target) {
  let current = value;
  let removedAlias = false;
  let markerIndex = current.indexOf(marker);

  while (markerIndex >= 0) {
    const before = current.slice(0, markerIndex);
    const after = current.slice(markerIndex + marker.length);
    const duplicatesAdjacentTarget = endsWithScopedTarget(before, target)
      || startsWithScopedTarget(after, target);
    current = `${before}${duplicatesAdjacentTarget ? '' : target}${after}`;
    removedAlias ||= duplicatesAdjacentTarget;
    markerIndex = current.indexOf(marker, markerIndex + (duplicatesAdjacentTarget ? 0 : target.length));
  }

  return removedAlias ? normalizeRemovedTranslationPunctuation(current) : current;
}

function startsWithScopedTarget(value, target) {
  const separator = String.raw`[\s\p{P}\p{S}]*`;
  const escaped = escapeRegExp(target);
  const boundary = containsCjk(target) ? '' : String.raw`(?=$|[^\p{L}\p{N}])`;
  return new RegExp(`^${separator}${escaped}${boundary}`, 'iu').test(value);
}

function endsWithScopedTarget(value, target) {
  const separator = String.raw`[\s\p{P}\p{S}]*`;
  const escaped = escapeRegExp(target);
  const boundary = containsCjk(target) ? '' : String.raw`(^|[^\p{L}\p{N}])`;
  return new RegExp(`${boundary}${escaped}${separator}$`, 'iu').test(value);
}

function normalizeRemovedTranslationPunctuation(value) {
  return value
    .replace(/^[\s\p{P}\p{S}]+/u, '')
    .replace(/([。！？.!?,，、；;：:])(?:\s*[。！？.!?,，、；;：:])+/gu, '$1')
    .replace(/\s+([。！？.!?,，、；;：:])/gu, '$1')
    .replace(/[\t ]{2,}/gu, ' ')
    .trim();
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
