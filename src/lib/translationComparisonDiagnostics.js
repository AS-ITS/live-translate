const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1_000;
const DEFAULT_RETENTION_MS = 15 * 60 * 1_000;
const MAX_TEXT_LENGTH = 12_000;
const MAX_ID_LENGTH = 512;

const TEXT_FIELDS = [
  'providerRawSource',
  'providerRawTranslation',
  'normalizedTranslation',
  'glossaryCorrectedTranslation',
  'canonicalTranslation',
  'previousCanonicalTranslation'
];

const ID_FIELDS = [
  'eventIdentity', 'meetingId', 'segmentId', 'cueId', 'audioTurnId',
  'providerEventId', 'normalizedEventId', 'turnKey', 'associationStatus',
  'stream', 'status', 'glossaryCorrectionStatus'
];

const NUMBER_FIELDS = [
  'cueSequence', 'providerEpoch', 'providerEventSequence',
  'sourceVersion', 'translationVersion'
];

const BOOLEAN_FIELDS = [
  'isFinal', 'isLateFinal', 'authoritativeSnapshotApplied'
];

export function createTranslationComparisonDiagnostics({
  allowed = true,
  enabled = false,
  limit = DEFAULT_LIMIT,
  retentionMs = DEFAULT_RETENTION_MS,
  now = () => Date.now()
} = {}) {
  const boundedLimit = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, MAX_LIMIT)
    : DEFAULT_LIMIT;
  const boundedRetentionMs = Number.isFinite(retentionMs) && retentionMs > 0
    ? retentionMs
    : DEFAULT_RETENTION_MS;
  const records = new Map();
  let active = allowed === true && enabled === true;

  function purgeExpired() {
    const cutoff = now() - boundedRetentionMs;
    for (const [eventIdentity, record] of records) {
      if (record.updatedAtMs >= cutoff) continue;
      records.delete(eventIdentity);
    }
  }

  function record(input = {}) {
    if (!allowed || !active) return null;
    const eventIdentity = boundedId(input.eventIdentity);
    if (!eventIdentity) return null;
    purgeExpired();

    const updatedAtMs = now();
    const previous = records.get(eventIdentity) || {
      eventIdentity,
      createdAt: new Date(updatedAtMs).toISOString(),
      stages: []
    };
    const patch = whitelistedPatch(input);
    const stages = input.stage && !previous.stages.includes(input.stage)
      ? [...previous.stages, boundedId(input.stage)]
      : previous.stages;
    const canonicalTranslation = patch.canonicalTranslation ?? previous.canonicalTranslation;
    const previousCanonicalTranslation = patch.previousCanonicalTranslation
      ?? previous.previousCanonicalTranslation;
    const providerRawSource = patch.providerRawSource ?? previous.providerRawSource;
    const next = Object.freeze({
      ...previous,
      ...patch,
      stages: Object.freeze(stages.filter(Boolean)),
      ...(canonicalTranslation === undefined ? {} : {
        revisionAnalysis: Object.freeze(analyzeTranslationRevision({
          previousTranslation: previousCanonicalTranslation,
          nextTranslation: canonicalTranslation,
          sourceText: providerRawSource
        }))
      }),
      timestamp: typeof input.timestamp === 'string'
        ? input.timestamp
        : new Date(updatedAtMs).toISOString(),
      updatedAtMs
    });
    records.delete(eventIdentity);
    records.set(eventIdentity, next);
    while (records.size > boundedLimit) records.delete(records.keys().next().value);
    return publicRecord(next);
  }

  function get(filter = {}) {
    if (!allowed || !active) return [];
    purgeExpired();
    return [...records.values()]
      .filter((record) => matchesFilter(record, filter))
      .map(publicRecord);
  }

  function clear() {
    records.clear();
  }

  function enable() {
    if (!allowed) return false;
    active = true;
    return true;
  }

  function disable() {
    active = false;
    clear();
    return true;
  }

  function exportJson() {
    return JSON.stringify({
      schemaVersion: 'translation-comparison/v1',
      exportedAt: new Date(now()).toISOString(),
      retentionMs: boundedRetentionMs,
      limit: boundedLimit,
      records: get()
    }, null, 2);
  }

  return Object.freeze({
    record,
    get,
    clear,
    enable,
    disable,
    exportJson,
    isAllowed: () => allowed === true,
    isEnabled: () => active,
    retentionMs: boundedRetentionMs,
    limit: boundedLimit
  });
}

export function analyzeTranslationRevision({
  previousTranslation,
  nextTranslation,
  sourceText
} = {}) {
  const previous = normalizedText(previousTranslation);
  const next = normalizedText(nextTranslation);
  const previousTokens = comparisonTokens(previous);
  const nextTokenCounts = tokenCounts(comparisonTokens(next));
  const lostTokens = previousTokens.filter((token) => {
    const remaining = nextTokenCounts.get(token) || 0;
    if (remaining === 0) return true;
    nextTokenCounts.set(token, remaining - 1);
    return false;
  });
  const previousNumbers = numericTokens(previous);
  const nextNumbers = new Set(numericTokens(next));
  const lostNumericTokens = previousNumbers.filter((token) => !nextNumbers.has(token));
  const relation = !previous
    ? 'initial'
    : previous === next
      ? 'same'
      : next.startsWith(previous)
        ? 'extension'
        : previous.startsWith(next)
          ? 'shortened'
          : next.length < previous.length && lostTokens.length > 0
            ? 'shortened'
            : 'rewrite';

  return {
    relation,
    previousLength: previous.length,
    nextLength: next.length,
    contentShortened: next.length < previous.length,
    lostTokens,
    lostNumericTokens,
    sourceCoverage: sourceText ? 'unverified' : 'unavailable',
    possibleProviderCorrection: ['shortened', 'rewrite'].includes(relation),
    informationLossRisk: lostTokens.length > 0 || lostNumericTokens.length > 0
  };
}

function whitelistedPatch(input) {
  const output = {};
  for (const field of ID_FIELDS) {
    if (input[field] !== undefined) output[field] = boundedId(input[field]);
  }
  for (const field of TEXT_FIELDS) {
    if (input[field] !== undefined) output[field] = boundedText(input[field]);
  }
  for (const field of NUMBER_FIELDS) {
    if (Number.isFinite(input[field])) output[field] = input[field];
  }
  for (const field of BOOLEAN_FIELDS) {
    if (input[field] !== undefined) output[field] = input[field] === true;
  }
  return output;
}

function matchesFilter(record, filter) {
  if (!filter || typeof filter !== 'object') return true;
  return Object.entries(filter).every(([key, value]) => value === undefined || record[key] === value);
}

function publicRecord(record) {
  const { updatedAtMs: _updatedAtMs, ...value } = record;
  return Object.freeze({ ...value, stages: Object.freeze([...value.stages]) });
}

function boundedId(value) {
  if (value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return String(value).slice(0, MAX_ID_LENGTH);
}

function boundedText(value) {
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  return value.slice(0, MAX_TEXT_LENGTH);
}

function normalizedText(value) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim() : '';
}

function comparisonTokens(value) {
  return normalizedText(value).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function numericTokens(value) {
  return normalizedText(value).match(/\p{N}+(?:[.,]\p{N}+)*/gu) || [];
}

function tokenCounts(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

const TRANSLATION_COMPARISON_ALLOWED = Boolean(
  import.meta.env?.DEV
  || (typeof __LIVE_TRANSLATE_DIAGNOSTICS__ !== 'undefined' && __LIVE_TRANSLATE_DIAGNOSTICS__)
);

export const translationComparisonDiagnostics = createTranslationComparisonDiagnostics({
  allowed: TRANSLATION_COMPARISON_ALLOWED
});
