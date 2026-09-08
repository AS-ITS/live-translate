export function normalizeCumulativeText(text) {
  return String(text || '').replace(/\s+/gu, ' ').trim();
}

export function cumulativeTextRelation(currentText, incomingText) {
  const current = normalizeCumulativeText(currentText);
  const incoming = normalizeCumulativeText(incomingText);
  if (!current || !incoming || current === incoming) return current === incoming && current ? 'same' : 'unrelated';
  if (incoming.startsWith(current)) return 'extension';
  if (current.startsWith(incoming)) return 'revision';
  return 'unrelated';
}

export function isCumulativeExtension(currentText, incomingText) {
  return cumulativeTextRelation(currentText, incomingText) === 'extension';
}

export function isCumulativeSnapshot(currentText, incomingText) {
  const relation = cumulativeTextRelation(currentText, incomingText);
  return relation === 'extension' || relation === 'revision';
}
