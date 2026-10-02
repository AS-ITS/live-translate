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

  return glossaryEntries.reduce((current, entry) => {
    if (!sourceContainsTerm(sourceText, entry?.source)) return current;
    if (typeof entry?.target !== 'string' || entry.target.trim() === '') return current;
    if (containsLiteral(current, entry.target)) return current;

    const candidates = [entry.source, ...(Array.isArray(entry.replacementAliases) ? entry.replacementAliases : [])]
      .filter((candidate) => typeof candidate === 'string' && candidate.trim() && candidate !== entry.target)
      .sort((left, right) => right.length - left.length);
    const replaced = candidates.reduce(
      (value, candidate) => replaceScopedCandidate(value, candidate, entry.target),
      current
    );
    if (replaced !== current) return replaced;
    return sourceEqualsTerm(sourceText, entry.source)
      ? `${entry.target.trim()}${trailingPunctuation(current)}`
      : current;
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
  const refinedTranslation = typeof cue.refinedTranslation === 'string'
    ? correctTranslationForSource({ sourceText, translatedText: cue.refinedTranslation }, glossaryEntries)
    : cue.refinedTranslation;
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

function replaceScopedCandidate(value, candidate, target) {
  if (containsCjk(candidate)) {
    return value.split(candidate).join(target);
  }
  const escaped = escapeRegExp(candidate);
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'giu');
  return value.replace(pattern, (_match, prefix) => `${prefix}${target}`);
}

function containsCjk(value) {
  return /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
