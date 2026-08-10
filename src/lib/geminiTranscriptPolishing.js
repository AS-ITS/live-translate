export const GEMINI_TRANSCRIPT_POLISHING_RESPONSE_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: Object.freeze({
    polishedItems: Object.freeze({
      type: 'ARRAY',
      items: Object.freeze({
        type: 'OBJECT',
        properties: Object.freeze({
          cueId: Object.freeze({ type: 'STRING' }),
          sequence: Object.freeze({ type: 'INTEGER' }),
          polishedText: Object.freeze({ type: 'STRING' })
        }),
        required: Object.freeze(['cueId', 'sequence', 'polishedText']),
        additionalProperties: false
      })
    })
  }),
  required: Object.freeze(['polishedItems']),
  additionalProperties: false
});

export function normalizeGeminiTranscriptPolishingItems(items, inputItems = [], { errorPrefix = 'Gemini polishing response' } = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new TypeError(`${errorPrefix} must contain non-empty polishedItems.`);
  const expectedByCueId = new Map();
  const expectedBySequence = new Map();
  for (const input of inputItems) {
    const cueId = input?.cueId;
    const sequence = input?.sequence;
    if (typeof cueId !== 'string' || cueId.trim() === '' || !Number.isInteger(sequence)
      || expectedByCueId.has(cueId) || expectedBySequence.has(sequence)) {
      throw new TypeError(`${errorPrefix} input Cues must have unique cueId and sequence.`);
    }
    expectedByCueId.set(cueId, sequence);
    expectedBySequence.set(sequence, cueId);
  }
  const seenCueIds = new Set();
  const seenSequences = new Set();
  const normalized = items.map((item) => {
    const sequence = normalizeSequence(item?.sequence);
    const hasValidCueId = typeof item?.cueId === 'string' && item.cueId.trim() !== '';
    const cueId = hasValidCueId ? item.cueId : expectedBySequence.get(sequence);
    const expectedSequence = cueId === undefined
      ? undefined
      : expectedByCueId.size === 0 ? sequence : expectedByCueId.get(cueId);
    if (typeof cueId !== 'string' || expectedSequence === undefined || expectedSequence !== sequence
      || seenCueIds.has(cueId) || seenSequences.has(sequence)
      || typeof item?.polishedText !== 'string' || item.polishedText.trim() === '') {
      throw new TypeError(`${errorPrefix} contains an invalid polished item or Cue mapping.`);
    }
    seenCueIds.add(cueId);
    seenSequences.add(sequence);
    return Object.freeze({
      cueId,
      sequence,
      polishedText: item.polishedText.trim()
    });
  });
  if (inputItems.length > 0 && (normalized.length !== expectedByCueId.size
    || [...expectedByCueId.keys()].some((cueId) => !seenCueIds.has(cueId)))) {
    throw new TypeError(`${errorPrefix} does not map one-to-one to input Cues.`);
  }
  return Object.freeze(normalized);
}

function normalizeSequence(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
