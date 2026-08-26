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

function isGlossaryAliasMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
