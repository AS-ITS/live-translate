let verifiedUserId = null;

export function setVerifiedLocalMeetingUserId(userId) {
  verifiedUserId = typeof userId === 'string' && userId ? userId : null;
}

function denied() {
  const error = new Error('Local meeting content belongs to another account or has no owner binding.');
  error.code = 'local_owner_forbidden';
  error.status = 403;
  return error;
}

function authenticatedUserId() {
  if (!verifiedUserId) throw denied();
  return verifiedUserId;
}

async function hasLocalContent(meetingId, manifestStore) {
  const collections = [
    'list', 'listCues', 'listTranscriptItems', 'listCheckpoints',
    'listUnassignedCues', 'listTranslatedAudioChunks', 'listSegments',
    'listPendingSegmentTransitions'
  ];
  const results = await Promise.all(collections.map((name) =>
    typeof manifestStore[name] === 'function' ? manifestStore[name](meetingId) : []));
  return results.some((items) => items.length > 0);
}

export function createLocalMeetingOwnerAccess({ getUserId = authenticatedUserId, createStorageIdentity = () => globalThis.crypto.randomUUID() } = {}) {
  async function assertOwner(meetingId, manifestStore) {
    if (!meetingId) throw denied();
    const userId = await getUserId();
    const recording = await manifestStore.getRecording(meetingId);
    if (!recording && !await hasLocalContent(meetingId, manifestStore)) {
      if (await getUserId() !== userId) throw denied();
      return { ownerUserId: userId, storageIdentity: null };
    }
    if (!recording?.ownerUserId || !recording?.storageIdentity || recording.ownerUserId !== userId) throw denied();
    if (await getUserId() !== userId) throw denied();
    return { ownerUserId: userId, storageIdentity: recording.storageIdentity };
  }

  return Object.freeze({
    assertOwner,
    async bindingForStart(meetingId, manifestStore) {
      const userId = await getUserId();
      const existing = await manifestStore.getRecording(meetingId);
      if (existing) return assertOwner(meetingId, manifestStore);
      // Never claim pre-cutover content that has no owner-bound recording.
      if (await hasLocalContent(meetingId, manifestStore)) throw denied();
      if (await getUserId() !== userId) throw denied();
      return { ownerUserId: userId, storageIdentity: createStorageIdentity() };
    },
    async withOwner(meetingId, manifestStore, work) {
      const binding = await assertOwner(meetingId, manifestStore);
      const result = await work();
      const current = await assertOwner(meetingId, manifestStore);
      if (current.storageIdentity !== binding.storageIdentity) throw denied();
      return result;
    }
  });
}
