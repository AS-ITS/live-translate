export function normalizeMeetingGlossaryAliases(value) {
  return Array.isArray(value)
    ? value.filter((alias) => typeof alias === 'string' && alias.trim() !== '')
    : [];
}

export function meetingGlossaryAliasesForTarget(value, targetLanguageCode) {
  if (Array.isArray(value)) return normalizeMeetingGlossaryAliases(value);
  if (isGlossaryAliasMap(value) && typeof targetLanguageCode === 'string') {
    return normalizeMeetingGlossaryAliases(value[targetLanguageCode]);
  }
  return [];
}

export function selectedMeetingGlossaryEntries(entries, selectedIds, targetLanguageCode) {
  const selected = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => selected.has(entry.id))
    .filter((entry) => entry?.enabled !== false)
    .filter((entry) => typeof entry?.source === 'string' && entry.source.trim() !== '')
    .map((entry) => ({
      source: entry.source,
      translations: { ...(entry.translations || {}) },
      replacementAliases: Object.fromEntries(
        Object.entries(isGlossaryAliasMap(entry.replacementAliases) ? entry.replacementAliases : {}).map(([languageCode, aliases]) => [
          languageCode,
          normalizeMeetingGlossaryAliases(aliases)
        ])
      )
    }));
}

export function liveGlossaryEntriesForTarget(entries = [], targetLanguageCode) {
  if (!Array.isArray(entries)) return [];

  return entries
    .filter((entry) => entry?.enabled !== false)
    .filter((entry) => entry?.scope === 'live' || entry?.scope === 'both')
    .map((entry) => ({
      id: entry.id,
      source: entry.source,
      target: entry.translations?.[targetLanguageCode],
      replacementAliases: Array.isArray(entry.replacementAliases?.[targetLanguageCode])
        ? entry.replacementAliases[targetLanguageCode]
        : []
    }))
    .filter((entry) => (
      typeof entry.source === 'string' &&
      entry.source.length > 0 &&
      typeof entry.target === 'string' &&
      entry.target.length > 0
    ));
}

function isGlossaryAliasMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
