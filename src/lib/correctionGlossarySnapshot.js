function normalizedIdentity(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function immutableEntries(entries) {
  return Object.freeze((Array.isArray(entries) ? entries : []).map((entry) => Object.freeze({
    ...entry,
    replacementAliases: Object.freeze([...(entry?.replacementAliases || [])])
  })));
}

export function correctionTurnIdentity(value = {}, connectionEpoch = 0) {
  const identity = [
    value.turnKey,
    value.audioTurnId,
    value.sourceAudioTurnId,
    value.translationAudioTurnId,
    value.boundaryAudioTurnId
  ].map(normalizedIdentity).find(Boolean);
  if (!identity) return null;
  return [
    normalizedIdentity(value.meetingId) || 'meeting-unbound',
    normalizedIdentity(value.segmentId) || 'segment-unbound',
    normalizedIdentity(value.providerEpoch) || '0',
    normalizedIdentity(connectionEpoch) || '0',
    identity
  ].join(':');
}

export function createCorrectionGlossaryRegistry({ maxTurnBindings = 1_024 } = {}) {
  let activeSnapshot = null;
  const snapshots = new Map();
  const turnBindings = new Map();

  function activate({ revision, entries } = {}) {
    const normalizedRevision = normalizedIdentity(revision);
    if (!normalizedRevision) throw new TypeError('correction glossary revision is required.');
    const snapshot = Object.freeze({
      revision: normalizedRevision,
      entries: immutableEntries(entries)
    });
    snapshots.set(snapshot.revision, snapshot);
    activeSnapshot = snapshot;
    return snapshot;
  }

  function activateIfEmpty(snapshot) {
    return activeSnapshot || activate(snapshot);
  }

  function bindTurn(value, connectionEpoch = 0) {
    if (!activeSnapshot) return null;
    const identity = correctionTurnIdentity(value, connectionEpoch);
    if (!identity) return activeSnapshot;
    const boundRevision = turnBindings.get(identity);
    if (boundRevision && snapshots.has(boundRevision)) return snapshots.get(boundRevision);
    turnBindings.set(identity, activeSnapshot.revision);
    while (turnBindings.size > maxTurnBindings) {
      turnBindings.delete(turnBindings.keys().next().value);
    }
    return activeSnapshot;
  }

  function snapshotForRevision(revision) {
    return snapshots.get(normalizedIdentity(revision)) || null;
  }

  return Object.freeze({
    activate,
    activateIfEmpty,
    bindTurn,
    active: () => activeSnapshot,
    snapshotForRevision,
    entriesForRevision: (revision) => snapshotForRevision(revision)?.entries || [],
    turnBindingCount: () => turnBindings.size
  });
}
