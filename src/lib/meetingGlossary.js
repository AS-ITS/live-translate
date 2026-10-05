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

export function effectiveMeetingGlossaryEntries(globalEntries = [], meetingEntries = [], targetLanguageCode) {
  return mergeMeetingGlossaryEntries(
    liveGlossaryEntriesForTarget(globalEntries, targetLanguageCode),
    meetingEntries,
    targetLanguageCode
  );
}

export function mergeMeetingGlossaryEntries(sharedEntries = [], privateEntries = [], targetLanguageCode) {
  const merged = new Map();

  for (const entry of Array.isArray(sharedEntries) ? sharedEntries : []) {
    addEntry(entry, false);
  }
  for (const entry of Array.isArray(privateEntries) ? privateEntries : []) {
    addEntry(entry, true);
  }

  return [...merged.values()];

  function addEntry(entry, meetingOwned) {
    const normalized = liveEntryForTarget(entry, targetLanguageCode);
    if (!normalized) return;
    const key = normalized.source.normalize('NFKC').trim().toLocaleLowerCase();
    const previous = merged.get(key);
    const replacementAliases = uniqueStrings([
      ...normalized.replacementAliases,
      ...(meetingOwned && previous?.target && previous.target !== normalized.target ? [previous.target] : []),
      ...(meetingOwned ? previous?.replacementAliases || [] : [])
    ]).filter((alias) => alias !== normalized.target);
    merged.set(key, {
      ...(normalized.id ? { id: normalized.id } : previous?.id ? { id: previous.id } : {}),
      ...normalized,
      replacementAliases
    });
  }
}

function liveEntryForTarget(entry, targetLanguageCode) {
  if (!entry || typeof entry.source !== 'string' || entry.source.trim() === '') return null;
  const target = typeof entry.target === 'string'
    ? entry.target
    : entry.translations?.[targetLanguageCode];
  if (typeof target !== 'string' || target.trim() === '') return null;
  return {
    ...(entry.id ? { id: entry.id } : {}),
    source: entry.source.trim(),
    target: target.trim(),
    replacementAliases: uniqueStrings(
      Array.isArray(entry.replacementAliases)
        ? entry.replacementAliases
        : entry.replacementAliases?.[targetLanguageCode] || []
    )
  };
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))];
}

function isGlossaryAliasMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
