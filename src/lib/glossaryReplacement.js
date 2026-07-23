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
