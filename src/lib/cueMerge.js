const IDENTITY_FIELDS = [
  'revision', 'meetingId', 'sessionId', 'segmentId', 'sequence',
  'startTimeMs', 'endTimeMs', 'status', 'sourceText', 'translatedText',
  'rawSource', 'rawTranslation', 'sourceVersion', 'translationVersion',
  'initialTranslation', 'refinedSource', 'refinedTranslation'
];

export function mergeCuesById(existingCues = [], incomingCues = []) {
  const byId = new Map();
  for (const cue of [...existingCues, ...incomingCues]) {
    if (!cue?.cueId) continue;
    const existing = byId.get(cue.cueId);
    if (existing && IDENTITY_FIELDS.some((field) => existing[field] !== cue[field])) {
      const error = new Error(`Cue ${cue.cueId} has conflicting payload.`);
      error.code = 'subtitle_cue_conflict';
      throw error;
    }
    if (!existing) byId.set(cue.cueId, cue);
  }
  return [...byId.values()].sort((left, right) => (
    (Number(left.sequence) || 0) - (Number(right.sequence) || 0)
    || (Number(left.startTimeMs) || 0) - (Number(right.startTimeMs) || 0)
    || left.cueId.localeCompare(right.cueId)
  ));
}
