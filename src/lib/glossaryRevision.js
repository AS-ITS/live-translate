export const EFFECTIVE_GLOSSARY_REVISION_CONTRACT = 'effective-glossary-v1';

export function canonicalEffectiveGlossary({
  sourceLanguageCode = '',
  targetLanguageCode = '',
  entries = []
} = {}) {
  return {
    contract: EFFECTIVE_GLOSSARY_REVISION_CONTRACT,
    sourceLanguageCode: normalizedString(sourceLanguageCode),
    targetLanguageCode: normalizedString(targetLanguageCode),
    entries: (Array.isArray(entries) ? entries : [])
      .map(normalizeEntry)
      .filter(Boolean)
      .sort(compareEntries)
  };
}

export function serializeEffectiveGlossary(input = {}) {
  return JSON.stringify(canonicalEffectiveGlossary(input));
}

export async function effectiveGlossaryRevision(input = {}) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('SHA-256 is unavailable in this runtime.');
  }
  const bytes = new TextEncoder().encode(serializeEffectiveGlossary(input));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const source = normalizedString(entry.source);
  const target = normalizedString(entry.target);
  if (!source || !target) return null;
  return {
    source,
    target,
    aliases: [...new Set((Array.isArray(entry.replacementAliases) ? entry.replacementAliases : [])
      .map(normalizedString)
      .filter(Boolean))]
      .sort(compareStrings)
  };
}

function normalizedString(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : '';
}

function compareEntries(left, right) {
  return compareStrings(left.source, right.source)
    || compareStrings(left.target, right.target)
    || compareStrings(left.aliases.join('\u0000'), right.aliases.join('\u0000'));
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}
