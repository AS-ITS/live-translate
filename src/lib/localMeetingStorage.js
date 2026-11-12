import { mergeCheckpoint } from '../application/meetingCheckpointService.js';
import { mergeFinalCue, validateFinalCue } from '../domain/subtitleCue/index.js';
import { applyCueMutation } from '../domain/subtitleCue/cueMutation.js';
import { advancePendingCue, classifyCueAuthority, MAX_PENDING_CUES_PER_MEETING,
  pendingCueKey, pendingOwnershipIsProven, projectPendingCue } from '../domain/subtitleCue/pendingCue.js';
import { checkCheckpointOperation, checkpointConflict, recordCheckpointOperation } from './checkpointOperation.js';
import { lifecycleIntentKey, projectLifecycleOperationIntent, sameLifecycleIntentIdentity } from './lifecycleOperationIntent.js';

export const LOCAL_MEETING_SCHEMA_VERSION = 6;
export const LOCAL_MEETING_DATABASE_VERSION = 13;
const UNASSIGNED_CUE_SCHEMA_VERSION = 1;

export const LOCAL_CHUNK_STATES = Object.freeze([
  'writing',
  'sealed',
  'missing',
  'corrupt',
  'orphan',
  'deleting'
]);

const STATE_SET = new Set(LOCAL_CHUNK_STATES);

export function buildLocalChunkPath({ meetingId, segmentId, sequence, chunkId, extension = 'webm' } = {}) {
  const meeting = safePathPart(meetingId, 'meetingId');
  const segment = safePathPart(segmentId, 'segmentId');
  const normalizedSequence = normalizePositiveInteger(sequence, 'sequence');
  const id = safePathPart(chunkId, 'chunkId');
  const suffix = String(extension || 'webm').replace(/[^a-z0-9]+/giu, '').toLowerCase() || 'webm';
  return `meetings/${meeting}/segments/${segment}/chunks/${String(normalizedSequence).padStart(8, '0')}-${id}.${suffix}`;
}

function projectTranslatedAudioChunk(input = {}) {
  const meetingId = safePathPart(input.meetingId, 'meetingId');
  const sessionId = safePathPart(input.sessionId, 'sessionId');
  const sequence = normalizePositiveInteger(input.sequence, 'sequence');
  const byteSize = normalizePositiveInteger(input.byteSize, 'byteSize');
  const checksum = normalizeRequiredString(input.checksum, 'checksum');
  const key = `${meetingId}\u0000${sessionId}\u0000${sequence}`;
  const path = `meetings/${meetingId}/translated-audio/${sessionId}/${String(sequence).padStart(8, '0')}.pcm`;
  if (input.key !== undefined && input.key !== key) throw conflict('local_translated_audio_identity_conflict');
  if (input.path !== undefined && input.path !== path) throw conflict('local_translated_audio_identity_conflict');
  return Object.freeze({ key, meetingId, sessionId, sequence, byteSize, checksum, path });
}

export function reserveLocalChunk({ meetingId, recordingId = meetingId, segmentId, chunkId, sequence, startedAt, endedAt = null, byteSize = null, checksum = null, mimeType = 'audio/webm' } = {}) {
  const record = {
    schemaVersion: LOCAL_MEETING_SCHEMA_VERSION,
    meetingId: safePathPart(meetingId, 'meetingId'),
    recordingId: safePathPart(recordingId, 'recordingId'),
    segmentId: safePathPart(segmentId, 'segmentId'),
    chunkId: safePathPart(chunkId, 'chunkId'),
    sequence: normalizePositiveInteger(sequence, 'sequence'),
    startedAt: normalizeTimestamp(startedAt, 'startedAt'),
    endedAt: endedAt === null ? null : normalizeTimestamp(endedAt, 'endedAt'),
    byteSize: normalizeOptionalNonNegativeInteger(byteSize, 'byteSize'),
    checksum: normalizeOptionalString(checksum, 'checksum'),
    mimeType: normalizeMimeType(mimeType),
    path: buildLocalChunkPath({ meetingId, segmentId, sequence, chunkId, extension: extensionForMimeType(mimeType) }),
    state: 'writing',
    createdAt: Date.now(),
    sealedAt: null,
    deleteRequestedAt: null
  };
  return Object.freeze(record);
}

export function sealLocalChunk(record, { byteSize, checksum, endedAt = record?.endedAt } = {}) {
  assertChunkRecord(record);
  if (record.state === 'sealed') {
    const normalizedByteSize = normalizeNonNegativeInteger(byteSize, 'byteSize');
    const normalizedChecksum = normalizeRequiredString(checksum, 'checksum');
    if (record.byteSize !== normalizedByteSize || record.checksum !== normalizedChecksum) {
      throw conflict('local_chunk_seal_conflict');
    }
    return record;
  }
  if (record.state !== 'writing') throw conflict('local_chunk_not_sealable');
  const sealed = {
    ...record,
    byteSize: normalizeNonNegativeInteger(byteSize, 'byteSize'),
    checksum: normalizeRequiredString(checksum, 'checksum'),
    endedAt: normalizeTimestamp(endedAt, 'endedAt'),
    state: 'sealed',
    sealedAt: Date.now()
  };
  if (sealed.endedAt < sealed.startedAt) throw invalid('endedAt must be after startedAt.');
  return Object.freeze(sealed);
}

export function markLocalChunk(record, state) {
  assertChunkRecord(record);
  if (!STATE_SET.has(state)) throw invalid(`Unknown local chunk state: ${state}.`);
  if (record.state === 'deleting' && state !== 'deleting') return record;
  const allowed = {
    writing: new Set(['writing', 'sealed', 'missing', 'corrupt', 'deleting']),
    sealed: new Set(['sealed', 'missing', 'corrupt', 'deleting']),
    missing: new Set(['missing', 'deleting']),
    corrupt: new Set(['corrupt', 'deleting']),
    orphan: new Set(['orphan', 'deleting']),
    deleting: new Set(['deleting'])
  };
  if (!allowed[record.state]?.has(state)) throw conflict('local_chunk_state_conflict');
  return Object.freeze({
    ...record,
    state,
    deleteRequestedAt: state === 'deleting' ? (record.deleteRequestedAt || Date.now()) : record.deleteRequestedAt
  });
}

export function reconcileLocalMeetingChunks({ manifest = [], files = [] } = {}) {
  const records = Array.isArray(manifest) ? manifest : [];
  const fileMap = new Map((Array.isArray(files) ? files : []).map((file) => [file.path, file]));
  const referencedPaths = new Set();
  const reconciled = records.map((record) => {
    assertChunkRecord(record);
    referencedPaths.add(record.path);
    const file = fileMap.get(record.path);
    if (!file) return record.state === 'writing' || record.state === 'sealed' ? markLocalChunk(record, 'missing') : record;
    if (record.state === 'writing' && matchesExpectedFile(record, file)) {
      return sealLocalChunk(record, {
        byteSize: file.byteSize,
        checksum: file.checksum,
        endedAt: record.endedAt || file.endedAt
      });
    }
    if (record.state === 'sealed' && !matchesExpectedFile(record, file)) return markLocalChunk(record, 'corrupt');
    return record;
  });

  const orphans = (Array.isArray(files) ? files : [])
    .filter((file) => !referencedPaths.has(file.path))
    .map((file) => ({
      path: String(file.path || ''),
      byteSize: normalizeOptionalNonNegativeInteger(file.byteSize, 'byteSize'),
      checksum: normalizeOptionalString(file.checksum, 'checksum'),
      state: 'orphan'
    }));

  return Object.freeze({ chunks: Object.freeze(reconciled), orphans: Object.freeze(orphans) });
}

function projectCheckpointFailure(input) {
  const { id, meetingId, segmentId, recordingId, cueId, mutationId,
    activeSegmentId, historical, operation, errorName, originalError, at } = input;
  return { id, meetingId, segmentId, recordingId, cueId, mutationId,
    activeSegmentId, historical, operation, errorName, originalError, at,
    key: JSON.stringify(['checkpoint-failure', meetingId, id]), type: 'checkpoint_failure' };
}

export function createInMemoryLocalMeetingManifestStore(initial = []) {
  const records = new Map();
  const recordings = new Map();
  const operations = new Map();
  const checkpointFailures = new Map();
  const segments = new Map();
  const cues = new Map();
  const cueOperations = new Map();
  const cueConflicts = new Map();
  const legacyCueBackups = new Map();
 const pendingCues = new Map();
 const cueAuthorities = new Map();
  const unassignedCues = new Map();
  const checkpoints = new Map();
  const transcripts = new Map();
  const translatedAudioChunks = new Map();
  const deletedMeetings = new Set();
  for (const rawRecord of initial) {
    const record = projectLocalChunk(rawRecord);
    assertChunkRecord(record);
    records.set(record.chunkId, record);
  }

  return Object.freeze({
    saveCheckpointFailure(input) {
      const record = projectCheckpointFailure(input);
      checkpointFailures.set(record.key, record);
      return record;
    },
    listCheckpointFailures(meetingId) {
      return [...checkpointFailures.values()].filter((record) => record.meetingId === meetingId);
    },
    getRecording(meetingId) {
      const value = recordings.get(meetingId);
      return value ? Object.freeze({ ...value }) : null;
    },
    saveRecording(input) {
      const record = projectLocalRecording(input);
      assertLocalRetentionWritable({ deleted: deletedMeetings.has(record.meetingId) });
      recordings.set(record.meetingId, record);
      return Object.freeze({ ...record });
    },
    getOperation(meetingId, operationId) {
      const value = operations.get(operationKey(meetingId, operationId));
      return value ? projectStoredRecordingOperation(value) : null;
    },
    getSegmentTransition(meetingId, operationId) {
      const value = operations.get(operationKey(meetingId, operationId));
      return value?.type === 'local_segment_transition' ? projectSegmentTransition(value) : null;
    },
    listPendingSegmentTransitions(meetingId) {
      return [...operations.values()].filter((value) => value.meetingId === meetingId
        && value.type === 'local_segment_transition' && value.phase === 'PREPARED').map(projectSegmentTransition);
    },
    listSegments(meetingId) {
      return [...segments.values()].filter((value) => value.meetingId === meetingId)
        .sort((left, right) => left.sequence - right.sequence);
    },
    prepareSegmentTransition(input) {
      const transition = projectSegmentTransition({ ...input, phase: 'PREPARED' });
      const existing = operations.get(transition.key);
      if (existing) return sameSegmentTransitionIdentity(existing, transition)
        ? projectSegmentTransition(existing) : conflictThrow('local_segment_transition_conflict');
      const recording = recordings.get(transition.meetingId);
      assertSegmentTransitionSource(recording, transition, segments.get(segmentKey(transition.meetingId, transition.predecessorId)));
      if ([...operations.values()].some((value) => value.meetingId === transition.meetingId
        && value.type === 'local_segment_transition' && value.phase === 'PREPARED')) {
        throw conflict('local_segment_transition_pending');
      }
      operations.set(transition.key, transition);
      return transition;
    },
    commitSegmentTransition(input) {
      const transition = projectSegmentTransition({ ...input, phase: 'PREPARED' });
      const existing = operations.get(transition.key);
      if (!existing || !sameSegmentTransitionIdentity(existing, transition)) throw conflict('local_segment_transition_conflict');
      if (existing.phase === 'COMMITTED') {
        if (!sameBoundary(existing.boundary, input.boundary)) throw conflict('local_segment_transition_conflict');
        return existing.result;
      }
      if (existing.phase !== 'PREPARED') throw conflict('local_segment_transition_aborted');
      const recording = recordings.get(transition.meetingId);
      const predecessor = segments.get(segmentKey(transition.meetingId, transition.predecessorId));
      assertSegmentTransitionSource(recording, transition, predecessor);
    const boundary = projectSegmentBoundary(input.boundary, transition, recording.pcmEnabled);
    assertTransitionBoundary(recording, transition, boundary);
      const successorKey = segmentKey(transition.meetingId, transition.successorId);
      if (segments.has(successorKey)) throw conflict('local_segment_successor_conflict');
      const result = { ...recording, segmentId: transition.successorId,
    segmentNumber: transition.successorSequence, providerEpoch: recording.providerEpoch + 1,
    state: recording.state === 'paused' ? 'capturing' : recording.state,
    captureEpoch: boundary ? boundary.captureEpoch + 1
      : recording.captureEpoch + (recording.state === 'paused' && !recording.pcmEnabled ? 1 : 0),
    pauseBoundary: null };
      segments.set(predecessor.key, projectLocalSegment({ ...predecessor, status: 'ENDED', activeMeetingId: null,
        lastJournalEpoch: boundary?.captureEpoch ?? null, endedByOperationId: transition.operationId }));
      segments.set(successorKey, projectLocalSegment({ meetingId: transition.meetingId,
        recordingId: transition.recordingId, segmentId: transition.successorId,
        sequence: transition.successorSequence, status: 'ACTIVE', activeMeetingId: transition.meetingId,
        firstJournalEpoch: boundary ? boundary.captureEpoch + 1 : null, provenance: 'native' }));
      recordings.set(recording.meetingId, projectLocalRecording(result));
      operations.set(transition.key, projectSegmentTransition({ ...transition, phase: 'COMMITTED', boundary, result }));
      return result;
    },
    abortSegmentTransition(input) {
      const transition = projectSegmentTransition({ ...input, phase: 'PREPARED' });
      const existing = operations.get(transition.key);
      if (!existing || !sameSegmentTransitionIdentity(existing, transition)) throw conflict('local_segment_transition_conflict');
      if (existing.phase === 'COMMITTED') return existing;
      if (existing.phase === 'ABORTED') return existing;
      const boundary = input.boundary ? projectSegmentBoundary(input.boundary, transition, recordings.get(transition.meetingId)?.pcmEnabled) : null;
      const aborted = projectSegmentTransition({ ...transition, phase: 'ABORTED', boundary,
        resolutionSegmentId: transition.predecessorId });
      operations.set(transition.key, aborted);
      return aborted;
    },
    saveContinueOperation(input) {
      const operation = projectContinueOperation(input);
      assertLocalRetentionWritable({ deleted: deletedMeetings.has(operation.meetingId) });
      const existing = operations.get(operation.key);
      if (existing && !sameContinueIdentity(existing, operation)) throw conflict('local_continue_operation_conflict');
      operations.set(operation.key, operation);
      return operation;
    },
    saveLifecycleIntent(input) {
      const intent = projectLifecycleOperationIntent(input);
      assertLocalRetentionWritable({ deleted: deletedMeetings.has(intent.meetingId) });
      const existing = operations.get(intent.key);
      if (existing && !sameLifecycleIntentIdentity(existing, intent)) throw conflict('local_lifecycle_intent_conflict');
      operations.set(intent.key, intent);
      return intent;
    },
    getLifecycleIntent(ownerUserId, meetingId, originalOperationId) {
      const value = operations.get(lifecycleIntentKey(ownerUserId, meetingId, originalOperationId));
      return value ? projectLifecycleOperationIntent(value) : null;
    },
    listPendingLifecycleIntents(ownerUserId, meetingId) {
      return [...operations.values()]
        .filter((value) => value.type === 'lifecycle_intent' && value.ownerUserId === ownerUserId
          && value.meetingId === meetingId && !['committed', 'rejected', 'expired'].includes(value.status))
        .map(projectLifecycleOperationIntent);
    },
    getPendingContinueOperation(meetingId) {
      const values = [...operations.values()]
        .filter((value) => value.meetingId === meetingId
          && value.type === 'legacy_continue'
          && value.state !== 'complete')
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
      return values[0] ? projectContinueOperation(values[0]) : null;
    },
    commitRecordingOperation({ recording: recordingInput, operation: operationInput }) {
      const recording = projectLocalRecording(recordingInput);
      assertLocalRetentionWritable({ deleted: deletedMeetings.has(recording.meetingId) });
      const operation = projectLocalOperation(operationInput);
      if (recording.meetingId !== operation.meetingId) throw conflict('local_recorder_operation_conflict');
      const key = operationKey(operation.meetingId, operation.operationId);
      const existing = operations.get(key);
      if (existing && !sameProjection(existing, operation)) throw conflict('local_recorder_operation_conflict');
      if (operation.type === 'start' && recording.integrityVersion === 2
        && !segments.has(segmentKey(recording.meetingId, recording.segmentId))) {
        const segment = initialLocalSegment(recording);
        if ([...segments.values()].some((item) => item.activeMeetingId === recording.meetingId)) {
          throw conflict('local_segment_active_conflict');
        }
        segments.set(segment.key, segment);
      }
      if (['resume', 'recover'].includes(operation.type) && recording.integrityVersion === 2) {
        const previous = recordings.get(recording.meetingId);
        if (previous && previous.segmentId !== recording.segmentId) {
          const oldKey = segmentKey(recording.meetingId, previous.segmentId);
          const oldSegment = segments.get(oldKey);
          if (oldSegment?.status !== 'ACTIVE') throw conflict('local_segment_active_conflict');
          segments.set(oldKey, projectLocalSegment({ ...oldSegment, status: 'ENDED',
            activeMeetingId: null, provenance: 'legacy-unverified', endedByOperationId: operation.operationId }));
          const next = projectLocalSegment({ meetingId: recording.meetingId, recordingId: recording.recordingId,
            segmentId: recording.segmentId, sequence: recording.segmentNumber, status: 'ACTIVE',
            provenance: 'legacy-unverified' });
          if (segments.has(next.key)) throw conflict('local_segment_successor_conflict');
          segments.set(next.key, next);
        }
      }
      if (operation.type === 'finalize' && recording.integrityVersion === 2) {
        const key = segmentKey(recording.meetingId, recording.segmentId);
        const active = segments.get(key);
        if (active?.status === 'ACTIVE') segments.set(key, projectLocalSegment({ ...active, status: 'ENDED',
          activeMeetingId: null, endedByOperationId: operation.operationId }));
      }
      recordings.set(recording.meetingId, recording);
      operations.set(key, operation);
      return operation.result;
    },
    async commitCueMutation(input) {
      const meetingId = normalizeRequiredString(input.meetingId, 'meetingId');
      const authority = classifyCueAuthority({ marker: cueAuthorities.get(meetingId),
        cues: [...cues.values()].filter((item) => item.meetingId === meetingId),
        checkpoints: [...checkpoints.values()].filter((item) => item.meetingId === meetingId),
        unassigned: [...unassignedCues.values()].filter((item) => item.meetingId === meetingId) });
      if (authority === 'legacy_readonly') return { status: 'rejected', reason: 'cue_legacy_readonly' };
      if (input.side === 'pending') {
        assertLocalRetentionWritable({ deleted: deletedMeetings.has(meetingId) });
        const projected = projectPendingCue(input);
        if (projected.status === 'rejected') return projected;
        const committed = [...cues.values()].find((item) => item.meetingId === meetingId
          && item.cueId === projected.record.cueId);
        if (committed) return { status: 'duplicate', cue: committed.cue };
        const existingPending = pendingCues.get(projected.record.key);
        if (!existingPending && [...pendingCues.values()].filter((item) => item.meetingId === meetingId).length
          >= MAX_PENDING_CUES_PER_MEETING) return { status: 'rejected', reason: 'cue_pending_meeting_limit' };
        const result = advancePendingCue(existingPending, projected.record,
          input.eventKey, JSON.stringify(input.cue));
        if (result.status === 'pending') {
          pendingCues.set(projected.record.key, result.pending);
          cueAuthorities.set(meetingId, { meetingId, mode: 'b2' });
        }
        return result;
      }
      const segmentId = normalizeRequiredString(input.segmentId, 'segmentId');
      const eventKey = normalizeRequiredString(input.eventKey, 'eventKey');
      assertLocalRetentionWritable({ deleted: deletedMeetings.has(meetingId) });
      const operationKey = JSON.stringify([meetingId, segmentId, eventKey]);
      const fingerprint = JSON.stringify([input.side, input.cue]);
      const priorOperation = cueOperations.get(operationKey);
      if (priorOperation) return priorOperation.fingerprint === fingerprint
        ? { ...priorOperation.result,
          status: priorOperation.result.status === 'rejected' ? 'rejected' : 'duplicate' }
        : { status: 'rejected', reason: 'cue_event_key_conflict' };
      const cueId = normalizeRequiredString(input.cue?.cueId, 'cueId');
      const foreignPending = [...pendingCues.values()].find((item) => item.meetingId === meetingId
        && item.cueId === cueId && item.sessionId !== input.cue?.sessionId);
      if (foreignPending) return { status: 'rejected', reason: 'cue_pending_identity_conflict' };
      const pendingKey = pendingCueKey(meetingId, input.cue?.sessionId, cueId);
      const pending = pendingCues.get(pendingKey);
      if (pending) {
        const matchingSegments = [...segments.values()].filter((item) => item.meetingId === meetingId
          && item.recordingId === input.cue.sessionId);
        const segment = matchingSegments.find((item) => item.segmentId === segmentId);
        if (!pendingOwnershipIsProven(pending, input.cue, segment, matchingSegments)) {
          return { status: 'rejected', reason: 'cue_pending_ownership_unproven' };
        }
      }
      const key = localCueKey(meetingId, segmentId, cueId);
      const existing = cues.get(key);
      const owner = [...cues.values()].find((record) => record.meetingId === meetingId
        && record.cueId === cueId && record.segmentId !== segmentId);
      const result = owner ? { status: 'rejected', reason: 'cue_segment_owner_conflict' }
        : applyCueMutation(existing?.cue ?? null, input);
      if (result.status === 'committed') {
        const record = projectLocalCue({ meetingId, segmentId, sessionId: input.cue.sessionId,
          cue: result.cue });
        const sequenceOwner = [...cues.values()].find((item) => item.meetingId === meetingId
          && item.segmentId === segmentId && item.sequence === record.sequence && item.cueId !== cueId);
        if (sequenceOwner) return recordCueRejection(cueConflicts, input, 'cue_sequence_owner_conflict', existing);
        cues.set(key, record);
        const checkpointKey = localCheckpointKey(meetingId, segmentId);
        const priorCheckpoint = checkpoints.get(checkpointKey)?.checkpoint ?? {};
        checkpoints.set(checkpointKey, projectLocalCheckpoint({ meetingId, segmentId,
          checkpoint: { ...priorCheckpoint, durableChunks: priorCheckpoint.durableChunks ?? [],
            finalCues: [], cueCheckpoint: null,
            cueCursor: { sequence: Math.max(priorCheckpoint.cueCursor?.sequence ?? 0, record.sequence),
              commitCount: (priorCheckpoint.cueCursor?.commitCount ?? 0) + 1 } }
        }));
      }
      if (result.status === 'rejected') recordCueRejection(cueConflicts, input, result.reason, existing);
      const response = result.status === 'committed'
        ? { status: 'committed', cue: result.cue, revision: result.cue.revision }
        : result;
      cueOperations.set(operationKey, { meetingId, fingerprint, result: response });
      if (result.status === 'committed') {
        cueAuthorities.set(meetingId, { meetingId, mode: 'b2' });
        if (pending) pendingCues.delete(pendingKey);
      }
      return response;
    },
    async listPendingCues(meetingId) {
      return [...pendingCues.values()].filter((item) => item.meetingId === meetingId);
    },
    async inspectCueAuthority(meetingId) {
      return classifyCueAuthority({ marker: cueAuthorities.get(meetingId),
        cues: [...cues.values()].filter((item) => item.meetingId === meetingId),
        checkpoints: [...checkpoints.values()].filter((item) => item.meetingId === meetingId),
        unassigned: [...unassignedCues.values()].filter((item) => item.meetingId === meetingId) });
    },
    async saveCheckpointCursor(input) {
      const incoming = projectLocalCheckpoint(input);
      assertLocalRetentionWritable({ deleted: deletedMeetings.has(incoming.meetingId) });
      const existing = checkpoints.get(incoming.key);
      const saved = mergeCursorCheckpoint(existing, incoming);
      checkpoints.set(incoming.key, saved);
      return saved;
    },
    async listCueConflicts(meetingId) {
      return [...cueConflicts.values()].filter((item) => item.meetingId === meetingId);
    },
    async upgradeLegacyCues(meetingId) {
      if (legacyCueBackups.has(meetingId)) return { status: 'upgraded' };
      const legacy = [...checkpoints.values()].filter((item) => item.meetingId === meetingId
        && (item.checkpoint?.finalCues?.length || item.checkpoint?.cueCheckpoint));
      const existingRecords = [...cues.values()].filter((item) => item.meetingId === meetingId);
      const needsRevisionUpgrade = existingRecords.some((item) => !Number.isSafeInteger(item.cue?.revision));
      if (legacy.length === 0 && !needsRevisionUpgrade) return { status: 'current' };
      if ([...unassignedCues.values()].some((item) => item.meetingId === meetingId && !item.cue?.dismissed)) {
        return { status: 'blocked', reason: 'cue_legacy_unassigned' };
      }
      const staged = new Map(cues);
      try {
        for (const record of existingRecords) staged.set(record.key, upgradeLegacyCueRecord(record));
        for (const item of legacy) {
          for (const cue of item.checkpoint.finalCues || []) {
            validateFinalCue(cue);
            const record = projectLocalCue({ meetingId, segmentId: item.segmentId,
              sessionId: cue.sessionId, cue });
            const original = cues.get(record.key);
            if (original && !sameCanonicalValue(original.cue, record.cue)) {
              const newer = mergeFinalCue([cue], original.cue).cue;
              if (!sameCanonicalValue(newer, original.cue)) throw conflict('cue_legacy_migration_conflict');
            }
            if (!original) staged.set(record.key, upgradeLegacyCueRecord(record));
          }
        }
      } catch {
        return { status: 'blocked', reason: 'cue_legacy_migration_conflict' };
      }
      legacyCueBackups.set(meetingId, { meetingId, checkpoints: legacy, cues: existingRecords, at: Date.now() });
      for (const [key, record] of staged) cues.set(key, record);
      for (const item of legacy) checkpoints.set(item.key, projectLocalCheckpoint({
        ...item, checkpoint: { ...item.checkpoint, finalCues: [], cueCheckpoint: null,
          cueCursor: { sequence: Math.max(0, ...[...staged.values()]
            .filter((record) => record.meetingId === meetingId && record.segmentId === item.segmentId)
            .map((record) => record.sequence)), commitCount: 0 } }
      }));
      return { status: 'upgraded' };
    },
    async getUnassignedCue(meetingId, sessionId, cueId) {
      return unassignedCues.get(unassignedCueKey(meetingId, sessionId, cueId)) || null;
    },
    async listUnassignedCues(meetingId) {
      normalizeRequiredString(meetingId, 'meetingId');
      return [...unassignedCues.values()]
        .filter((cue) => cue.meetingId === meetingId)
        .sort(compareLocalCues);
    },
    async countUnassignedCues(meetingId) {
      return (await this.listUnassignedCues(meetingId)).length;
    },
    async listCues(meetingId, { segmentId } = {}) {
      return Object.freeze([...cues.values()]
        .filter((record) => record.meetingId === meetingId && (!segmentId || record.segmentId === segmentId))
        .sort(compareLocalCues)
        .map((record) => projectLocalCue(record)));
    },
    async saveTranscriptItem(input) {
      const item = projectLocalTranscript(input);
      assertLocalRetentionWritable({ deleted: deletedMeetings.has(item.meetingId) });
      const saved = mergeLocalTranscript(transcripts.get(item.key), item);
      transcripts.set(item.key, saved);
      return saved;
    },
    async listTranscriptItems(meetingId) {
      return [...transcripts.values()].filter((item) => item.meetingId === meetingId)
        .sort(compareLocalTranscripts);
    },
    async getCheckpoint(meetingId, segmentId) {
      const value = checkpoints.get(localCheckpointKey(meetingId, segmentId));
      return value ? projectLocalCheckpoint(value) : null;
    },
    async listCheckpoints(meetingId) {
      return [...checkpoints.values()].filter((checkpoint) => checkpoint.meetingId === meetingId);
    },
    async clearMeetingContent(meetingId) {
      deletedMeetings.add(meetingId);
    for (const collection of [records, recordings, operations, checkpointFailures, segments, cues, cueOperations, cueConflicts, legacyCueBackups, pendingCues, cueAuthorities, unassignedCues, checkpoints, transcripts, translatedAudioChunks]) {
        for (const [key, value] of collection) {
          if (value.meetingId === meetingId) collection.delete(key);
        }
      }
    },
    async saveTranslatedAudioChunk(input) {
      const chunk = projectTranslatedAudioChunk(input);
      assertLocalRetentionWritable({ deleted: deletedMeetings.has(chunk.meetingId) });
      const existing = translatedAudioChunks.get(chunk.key);
      if (existing && !sameCanonicalValue(existing, chunk)) throw conflict('local_translated_audio_conflict');
      translatedAudioChunks.set(chunk.key, chunk);
      return chunk;
    },
    async listTranslatedAudioChunks(meetingId) {
      return [...translatedAudioChunks.values()].filter((chunk) => chunk.meetingId === meetingId)
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId) || left.sequence - right.sequence);
    },
    async reserve(input) {
      const record = reserveLocalChunk(input);
      assertLocalRetentionWritable({ deleted: deletedMeetings.has(record.meetingId) });
      const existing = records.get(record.chunkId);
      if (existing) {
        if (!sameChunkIdentity(existing, record)) {
          throw conflict('local_chunk_identity_conflict');
        }
        return Object.freeze({ ...existing });
      }
      if ([...records.values()].some((value) => value.meetingId === record.meetingId && value.sequence === record.sequence)) {
        throw conflict('local_chunk_sequence_conflict');
      }
      records.set(record.chunkId, { ...record });
      return Object.freeze({ ...record });
    },
    async seal(chunkId, input) {
      const current = getRecord(records, chunkId);
      const next = sealLocalChunk(current, input);
      records.set(chunkId, { ...next });
      return Object.freeze({ ...next });
    },
    async mark(chunkId, state) {
      const next = markLocalChunk(getRecord(records, chunkId), state);
      records.set(chunkId, { ...next });
      return Object.freeze({ ...next });
    },
    async get(chunkId) {
      const value = records.get(chunkId);
      return value ? projectLocalChunk(value) : null;
    },
    async list(meetingId) {
      return Object.freeze([...records.values()]
        .filter((record) => meetingId === undefined || record.meetingId === meetingId)
        .sort((left, right) => left.sequence - right.sequence)
        .map(projectLocalChunk));
    }
  });
}

export function createIndexedDbLocalMeetingManifestStore({
  indexedDBImpl = globalThis.indexedDB,
  dbName = 'live-translate-local-meetings-v1'
} = {}) {
  if (!indexedDBImpl || typeof indexedDBImpl.open !== 'function') throw new Error('IndexedDB is unavailable.');
  let databasePromise;

  return Object.freeze({
    async saveCheckpointFailure(input) {
      const database = await openDatabase();
      const record = projectCheckpointFailure(input);
      return runNamedTransaction(database, 'operations', 'readwrite', async (transaction) => {
        await request(transaction.objectStore('operations').put(record));
        return record;
      });
    },
    async listCheckpointFailures(meetingId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'operations', 'readonly', async (transaction) =>
        (await request(transaction.objectStore('operations').getAll()))
          .filter((record) => record.type === 'checkpoint_failure' && record.meetingId === meetingId));
    },
    async getRetention(meetingId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'retentions', 'readonly', async (transaction) =>
        (await request(transaction.objectStore('retentions').get(meetingId))) || null);
    },
    async listRetentions() {
      const database = await openDatabase();
      return runNamedTransaction(database, 'retentions', 'readonly', async (transaction) =>
        request(transaction.objectStore('retentions').getAll()));
    },
    async saveRetention(input) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'retentions', 'readwrite', async (transaction) => {
        const store = transaction.objectStore('retentions');
        const previous = await request(store.get(input.meetingId));
        const previousExpiry = Date.parse(previous?.expiresAt || '');
        const nextExpiry = Date.parse(input.expiresAt || '');
        const record = {
          ...previous,
          ...input,
          recordingId: previous?.recordingId || input.recordingId || null,
          expiresAt: Number.isFinite(previousExpiry) && Number.isFinite(nextExpiry)
            ? new Date(Math.min(previousExpiry, nextExpiry)).toISOString()
            : previous?.expiresAt || input.expiresAt || null,
          deleted: Boolean(previous?.deleted || input.deleted),
          physicalCleared: Boolean(previous?.physicalCleared)
        };
        await request(store.put(record));
        return record;
      });
    },
    async listLocalMeetingIds() {
      const database = await openDatabase();
      return runNamedTransaction(database, ['recordings', 'segments', 'chunks', 'cues', 'pendingCues', 'checkpoints', 'unassignedCues', 'transcripts', 'translatedAudioChunks'], 'readonly', async (transaction) => {
        const records = await Promise.all(['recordings', 'segments', 'chunks', 'cues', 'pendingCues', 'checkpoints', 'unassignedCues', 'transcripts', 'translatedAudioChunks']
          .map((name) => request(transaction.objectStore(name).getAll())));
        return [...new Set(records.flat().map((row) => row.meetingId).filter(Boolean))];
      });
    },
    async clearMeetingContent(meetingId) {
      const database = await openDatabase();
      return runNamedTransaction(database,
      ['recordings', 'segments', 'chunks', 'operations', 'cues', 'cueOperations', 'cueConflicts', 'legacyCueBackups', 'pendingCues', 'cueAuthorities', 'checkpoints', 'retentions', 'unassignedCues', 'transcripts', 'translatedAudioChunks'], 'readwrite',
        async (transaction) => {
        for (const name of ['recordings', 'segments', 'chunks', 'operations', 'cues', 'cueOperations', 'cueConflicts', 'legacyCueBackups', 'pendingCues', 'cueAuthorities', 'checkpoints', 'unassignedCues', 'transcripts', 'translatedAudioChunks']) {
            const store = transaction.objectStore(name);
            const records = await request(store.getAll());
            for (const row of records) {
              if (row.meetingId === meetingId) await request(store.delete(
                name === 'recordings' || name === 'legacyCueBackups' || name === 'cueAuthorities'
                  ? meetingId : row.key || row.chunkId));
            }
          }
          const retentions = transaction.objectStore('retentions');
          const record = await request(retentions.get(meetingId));
          await request(retentions.put({ ...record, meetingId,
            deleted: true, physicalCleared: true, cleanupError: null }));
        });
    },
    async getRecording(meetingId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'recordings', 'readwrite', async (transaction) => {
        const store = transaction.objectStore('recordings');
        const raw = await request(store.get(meetingId));
        if (!raw) return null;
        const projected = projectLocalRecording(raw);
        if (!sameProjection(raw, projected)) await request(store.put(projected));
        return projected;
      });
    },
    async saveRecording(input) {
      const recording = projectLocalRecording(input);
      const database = await openDatabase();
      return runNamedTransaction(database, ['recordings', 'retentions'], 'readwrite', async (transaction) => {
        assertLocalRetentionWritable(await request(transaction.objectStore('retentions').get(recording.meetingId)));
        await request(transaction.objectStore('recordings').put(recording));
        return recording;
      });
    },
    async getOperation(meetingId, operationId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'operations', 'readwrite', async (transaction) => {
        const store = transaction.objectStore('operations');
        const raw = await request(store.get(operationKey(meetingId, operationId)));
        if (!raw) return null;
        const projected = projectStoredRecordingOperation(raw);
        if (!sameProjection(raw, projected)) await request(store.put(projected));
        return projected;
      });
    },
    async getSegmentTransition(meetingId, operationId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'operations', 'readonly', async (transaction) => {
        const value = await request(transaction.objectStore('operations').get(operationKey(meetingId, operationId)));
        return value?.type === 'local_segment_transition' ? projectSegmentTransition(value) : null;
      });
    },
    async listPendingSegmentTransitions(meetingId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'operations', 'readonly', async (transaction) =>
        (await request(transaction.objectStore('operations').getAll()))
          .filter((value) => value.meetingId === meetingId && value.type === 'local_segment_transition'
            && value.phase === 'PREPARED').map(projectSegmentTransition));
    },
    async listSegments(meetingId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'segments', 'readonly', async (transaction) =>
        (await request(transaction.objectStore('segments').getAll()))
          .filter((value) => value.meetingId === meetingId).map(projectLocalSegment)
          .sort((left, right) => left.sequence - right.sequence));
    },
    async prepareSegmentTransition(input) {
      const transition = projectSegmentTransition({ ...input, phase: 'PREPARED' });
      const database = await openDatabase();
      return runNamedTransaction(database, ['recordings', 'operations', 'segments', 'retentions'], 'readwrite', async (transaction) => {
        assertLocalRetentionWritable(await request(transaction.objectStore('retentions').get(transition.meetingId)));
        const operations = transaction.objectStore('operations');
        const existing = await request(operations.get(transition.key));
        if (existing) {
          if (!sameSegmentTransitionIdentity(existing, transition)) throw conflict('local_segment_transition_conflict');
          return projectSegmentTransition(existing);
        }
        const recording = await request(transaction.objectStore('recordings').get(transition.meetingId));
        const predecessor = await request(transaction.objectStore('segments').get(segmentKey(transition.meetingId, transition.predecessorId)));
        assertSegmentTransitionSource(recording, transition, predecessor);
        const pending = (await request(operations.getAll())).some((value) => value.meetingId === transition.meetingId
          && value.type === 'local_segment_transition' && value.phase === 'PREPARED');
        if (pending) throw conflict('local_segment_transition_pending');
        await request(operations.add(transition));
        return transition;
      });
    },
    async commitSegmentTransition(input) {
      const transition = projectSegmentTransition({ ...input, phase: 'PREPARED' });
      const database = await openDatabase();
      return runNamedTransaction(database, ['recordings', 'operations', 'segments', 'retentions'], 'readwrite', async (transaction) => {
        assertLocalRetentionWritable(await request(transaction.objectStore('retentions').get(transition.meetingId)));
        const operations = transaction.objectStore('operations');
        const existing = await request(operations.get(transition.key));
        if (!existing || !sameSegmentTransitionIdentity(existing, transition)) throw conflict('local_segment_transition_conflict');
        if (existing.phase === 'COMMITTED') {
          if (!sameBoundary(existing.boundary, input.boundary)) throw conflict('local_segment_transition_conflict');
          return existing.result;
        }
        if (existing.phase !== 'PREPARED') throw conflict('local_segment_transition_aborted');
        const recordings = transaction.objectStore('recordings');
        const segments = transaction.objectStore('segments');
        const recording = await request(recordings.get(transition.meetingId));
        const predecessor = await request(segments.get(segmentKey(transition.meetingId, transition.predecessorId)));
        assertSegmentTransitionSource(recording, transition, predecessor);
      const boundary = projectSegmentBoundary(input.boundary, transition, recording.pcmEnabled);
      assertTransitionBoundary(recording, transition, boundary);
        const successorKey = segmentKey(transition.meetingId, transition.successorId);
        if (await request(segments.get(successorKey))) throw conflict('local_segment_successor_conflict');
        const result = projectLocalRecording({ ...recording, segmentId: transition.successorId,
        segmentNumber: transition.successorSequence, providerEpoch: recording.providerEpoch + 1,
        state: recording.state === 'paused' ? 'capturing' : recording.state,
        captureEpoch: boundary ? boundary.captureEpoch + 1
          : recording.captureEpoch + (recording.state === 'paused' && !recording.pcmEnabled ? 1 : 0),
        pauseBoundary: null });
        await request(segments.put(projectLocalSegment({ ...predecessor, status: 'ENDED', activeMeetingId: null,
          lastJournalEpoch: boundary?.captureEpoch ?? null, endedByOperationId: transition.operationId })));
        await request(segments.add(projectLocalSegment({ meetingId: transition.meetingId,
          recordingId: transition.recordingId, segmentId: transition.successorId,
          sequence: transition.successorSequence, status: 'ACTIVE', activeMeetingId: transition.meetingId,
          firstJournalEpoch: boundary ? boundary.captureEpoch + 1 : null, provenance: 'native' })));
        await request(recordings.put(result));
        await request(operations.put(projectSegmentTransition({ ...transition, phase: 'COMMITTED', boundary, result })));
        return result;
      });
    },
    async abortSegmentTransition(input) {
      const transition = projectSegmentTransition({ ...input, phase: 'PREPARED' });
      const database = await openDatabase();
      return runNamedTransaction(database, ['operations', 'recordings', 'retentions'], 'readwrite', async (transaction) => {
        assertLocalRetentionWritable(await request(transaction.objectStore('retentions').get(transition.meetingId)));
        const operations = transaction.objectStore('operations');
        const existing = await request(operations.get(transition.key));
        if (!existing || !sameSegmentTransitionIdentity(existing, transition)) throw conflict('local_segment_transition_conflict');
        if (existing.phase !== 'PREPARED') return projectSegmentTransition(existing);
        const recording = await request(transaction.objectStore('recordings').get(transition.meetingId));
        if (recording?.segmentId !== transition.predecessorId) throw conflict('local_segment_transition_conflict');
        const boundary = input.boundary ? projectSegmentBoundary(input.boundary, transition, recording.pcmEnabled) : null;
        const aborted = projectSegmentTransition({ ...transition, phase: 'ABORTED', boundary,
          resolutionSegmentId: transition.predecessorId });
        await request(operations.put(aborted));
        return aborted;
      });
    },
    async saveContinueOperation(input) {
      const operation = projectContinueOperation(input);
      const database = await openDatabase();
      return runNamedTransaction(database, ['operations', 'retentions'], 'readwrite', async (transaction) => {
        assertLocalRetentionWritable(await request(transaction.objectStore('retentions').get(operation.meetingId)));
        const store = transaction.objectStore('operations');
        const existing = await request(store.get(operation.key));
        if (existing && !sameContinueIdentity(existing, operation)) throw conflict('local_continue_operation_conflict');
        await request(store.put(operation));
        return operation;
      });
    },
    async saveLifecycleIntent(input) {
      const intent = projectLifecycleOperationIntent(input);
      const database = await openDatabase();
      return runNamedTransaction(database, ['operations', 'retentions'], 'readwrite', async (transaction) => {
        assertLocalRetentionWritable(await request(transaction.objectStore('retentions').get(intent.meetingId)));
        const store = transaction.objectStore('operations');
        const existing = await request(store.get(intent.key));
        if (existing && !sameLifecycleIntentIdentity(existing, intent)) throw conflict('local_lifecycle_intent_conflict');
        await request(store.put(intent));
        return intent;
      });
    },
    async getLifecycleIntent(ownerUserId, meetingId, originalOperationId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'operations', 'readonly', async (transaction) => {
        const value = await request(transaction.objectStore('operations').get(
          lifecycleIntentKey(ownerUserId, meetingId, originalOperationId)));
        return value ? projectLifecycleOperationIntent(value) : null;
      });
    },
    async listPendingLifecycleIntents(ownerUserId, meetingId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'operations', 'readonly', async (transaction) => {
        const values = await request(transaction.objectStore('operations').getAll());
        return values.filter((value) => value.type === 'lifecycle_intent'
          && value.ownerUserId === ownerUserId && value.meetingId === meetingId
          && !['committed', 'rejected', 'expired'].includes(value.status))
          .map(projectLifecycleOperationIntent);
      });
    },
    async getPendingContinueOperation(meetingId) {
      normalizeRequiredString(meetingId, 'meetingId');
      const database = await openDatabase();
      return runNamedTransaction(database, 'operations', 'readonly', async (transaction) => {
        const values = await request(transaction.objectStore('operations').getAll());
        const matches = values
          .filter((value) => value.meetingId === meetingId
            && value.type === 'legacy_continue'
            && value.state !== 'complete')
          .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
        return matches[0] ? projectContinueOperation(matches[0]) : null;
      });
    },
    async commitRecordingOperation({ recording: recordingInput, operation: operationInput }) {
      const recording = projectLocalRecording(recordingInput);
      const operation = projectLocalOperation(operationInput);
      if (recording.meetingId !== operation.meetingId) throw conflict('local_recorder_operation_conflict');
      const database = await openDatabase();
      return runNamedTransaction(database, ['recordings', 'operations', 'segments', 'retentions'], 'readwrite', async (transaction) => {
        assertLocalRetentionWritable(await request(transaction.objectStore('retentions').get(recording.meetingId)));
        const operationStore = transaction.objectStore('operations');
        const existing = await request(operationStore.get(operation.key));
        if (existing && !sameProjection(projectLocalOperation(existing), operation)) {
          throw conflict('local_recorder_operation_conflict');
        }
        const segments = transaction.objectStore('segments');
        if (operation.type === 'start' && recording.integrityVersion === 2) {
          const key = segmentKey(recording.meetingId, recording.segmentId);
          if (!await request(segments.get(key))) await request(segments.add(initialLocalSegment(recording)));
        }
        if (['resume', 'recover'].includes(operation.type) && recording.integrityVersion === 2) {
          const previous = await request(transaction.objectStore('recordings').get(recording.meetingId));
          if (previous && previous.segmentId !== recording.segmentId) {
            const oldKey = segmentKey(recording.meetingId, previous.segmentId);
            const oldSegment = await request(segments.get(oldKey));
            if (oldSegment?.status !== 'ACTIVE') throw conflict('local_segment_active_conflict');
            await request(segments.put(projectLocalSegment({ ...oldSegment, status: 'ENDED',
              activeMeetingId: null, provenance: 'legacy-unverified', endedByOperationId: operation.operationId })));
            const next = projectLocalSegment({ meetingId: recording.meetingId, recordingId: recording.recordingId,
              segmentId: recording.segmentId, sequence: recording.segmentNumber, status: 'ACTIVE',
              provenance: 'legacy-unverified' });
            if (await request(segments.get(next.key))) throw conflict('local_segment_successor_conflict');
            await request(segments.add(next));
          }
        }
        if (operation.type === 'finalize' && recording.integrityVersion === 2) {
          const key = segmentKey(recording.meetingId, recording.segmentId);
          const active = await request(segments.get(key));
          if (active?.status === 'ACTIVE') await request(segments.put(projectLocalSegment({ ...active,
            status: 'ENDED', activeMeetingId: null, endedByOperationId: operation.operationId })));
        }
        await request(transaction.objectStore('recordings').put(recording));
        if (!existing) await request(operationStore.add(operation));
        return operation.result;
      });
    },
    async commitCueMutation(input) {
      const meetingId = normalizeRequiredString(input.meetingId, 'meetingId');
      const segmentId = input.side === 'pending' ? null : normalizeRequiredString(input.segmentId, 'segmentId');
      const eventKey = normalizeRequiredString(input.eventKey, 'eventKey');
      const cueId = normalizeRequiredString(input.cue?.cueId, 'cueId');
      const database = await openDatabase();
      return runNamedTransaction(database,
        ['cues', 'checkpoints', 'retentions', 'cueOperations', 'cueConflicts',
          'pendingCues', 'cueAuthorities', 'unassignedCues', 'segments'], 'readwrite',
        async (transaction) => {
          assertLocalRetentionWritable(await request(transaction.objectStore('retentions').get(meetingId)));
          const cueStore = transaction.objectStore('cues');
          const pendingStore = transaction.objectStore('pendingCues');
          const authorityStore = transaction.objectStore('cueAuthorities');
          const marker = await request(authorityStore.get(meetingId));
          if (!marker) {
            const [priorCues, priorCheckpoints, priorUnassigned] = await Promise.all([
              request(cueStore.getAll()),
              request(transaction.objectStore('checkpoints').getAll()),
              request(transaction.objectStore('unassignedCues').index('meetingId').getAll(meetingId))
            ]);
            if (classifyCueAuthority({ cues: priorCues.filter((item) => item.meetingId === meetingId),
              checkpoints: priorCheckpoints.filter((item) => item.meetingId === meetingId),
              unassigned: priorUnassigned }) === 'legacy_readonly') {
              return { status: 'rejected', reason: 'cue_legacy_readonly' };
            }
          }
          if (input.side === 'pending') {
            const projected = projectPendingCue(input);
            if (projected.status === 'rejected') return projected;
            const committed = await request(cueStore.index('meeting-cue-id').getAll([meetingId, cueId]));
            if (committed.length) return { status: 'duplicate', cue: committed[0].cue };
            const prior = await request(pendingStore.get(projected.record.key));
            if (!prior) {
              const count = (await request(pendingStore.index('meetingId').getAll(meetingId))).length;
              if (count >= MAX_PENDING_CUES_PER_MEETING) {
                return { status: 'rejected', reason: 'cue_pending_meeting_limit' };
              }
            }
            const result = advancePendingCue(prior, projected.record,
              eventKey, JSON.stringify(input.cue));
            if (result.status === 'pending') {
              await request(pendingStore.put(result.pending));
              await request(authorityStore.put({ meetingId, mode: 'b2' }));
            }
            return result;
          }
          const operationStore = transaction.objectStore('cueOperations');
          const operationKey = JSON.stringify([meetingId, segmentId, eventKey]);
          const fingerprint = JSON.stringify([input.side, input.cue]);
          const priorOperation = await request(operationStore.get(operationKey));
          if (priorOperation) return priorOperation.fingerprint === fingerprint
            ? { ...priorOperation.result,
              status: priorOperation.result.status === 'rejected' ? 'rejected' : 'duplicate' }
            : { status: 'rejected', reason: 'cue_event_key_conflict' };
          const key = localCueKey(meetingId, segmentId, cueId);
          const sameMeetingPending = await request(pendingStore.index('meetingId').getAll(meetingId));
          if (sameMeetingPending.some((item) => item.cueId === cueId
            && item.sessionId !== input.cue?.sessionId)) {
            return { status: 'rejected', reason: 'cue_pending_identity_conflict' };
          }
          const pendingKey = pendingCueKey(meetingId, input.cue?.sessionId, cueId);
          const pending = await request(pendingStore.get(pendingKey));
          if (pending) {
            const candidateSegments = (await request(transaction.objectStore('segments').getAll()))
              .filter((item) => item.meetingId === meetingId && item.recordingId === input.cue.sessionId);
            const segment = candidateSegments.find((item) => item.segmentId === segmentId);
            if (!pendingOwnershipIsProven(pending, input.cue, segment, candidateSegments)) {
              return { status: 'rejected', reason: 'cue_pending_ownership_unproven' };
            }
          }
          const existing = await request(cueStore.get(key));
          const owners = await request(cueStore.index('meeting-cue-id').getAll([meetingId, cueId]));
          let result = owners.some((record) => record.segmentId !== segmentId)
            ? { status: 'rejected', reason: 'cue_segment_owner_conflict' }
            : applyCueMutation(existing?.cue ?? null, input);
          if (result.status === 'committed') {
            const record = projectLocalCue({ meetingId, segmentId,
              sessionId: input.cue.sessionId, cue: result.cue });
            const sequenceOwners = await request(cueStore.index('meeting-segment-sequence').getAll(
              [meetingId, segmentId, record.sequence]));
            if (sequenceOwners.some((owner) => owner.cueId !== cueId)) {
              result = { status: 'rejected', reason: 'cue_sequence_owner_conflict' };
            } else {
              await request(cueStore.put(record));
              const checkpointStore = transaction.objectStore('checkpoints');
              const checkpointKey = localCheckpointKey(meetingId, segmentId);
              const priorCheckpoint = await request(checkpointStore.get(checkpointKey));
              const checkpoint = priorCheckpoint?.checkpoint ?? {};
              await request(checkpointStore.put(projectLocalCheckpoint({ meetingId, segmentId,
                checkpoint: { ...checkpoint, durableChunks: checkpoint.durableChunks ?? [],
                  finalCues: [], cueCheckpoint: null,
                  cueCursor: { sequence: Math.max(checkpoint.cueCursor?.sequence ?? 0, record.sequence),
                    commitCount: (checkpoint.cueCursor?.commitCount ?? 0) + 1 } }
              })));
            }
          }
          if (result.status === 'rejected') {
            const conflictStore = transaction.objectStore('cueConflicts');
            const item = cueRejectionRecord(input, result.reason, existing);
            await request(conflictStore.put(item));
            const all = await request(conflictStore.index('meetingId').getAll(meetingId));
            for (const old of all.sort((a, b) => a.at - b.at).slice(0, Math.max(0, all.length - 100))) {
              await request(conflictStore.delete(old.key));
            }
          }
          const response = result.status === 'committed'
            ? { status: 'committed', cue: result.cue, revision: result.cue.revision }
            : result;
          await request(operationStore.put({ key: operationKey, meetingId, fingerprint, result: response }));
          if (result.status === 'committed') {
            await request(authorityStore.put({ meetingId, mode: 'b2' }));
            if (pending) await request(pendingStore.delete(pendingKey));
          }
          return response;
        });
    },
    async listPendingCues(meetingId) {
      const database = await openDatabase();
      return runNamedTransaction(database, ['pendingCues'], 'readonly', (transaction) =>
        request(transaction.objectStore('pendingCues').index('meetingId').getAll(meetingId)));
    },
    async inspectCueAuthority(meetingId) {
      const database = await openDatabase();
      return runNamedTransaction(database,
        ['cueAuthorities', 'cues', 'checkpoints', 'unassignedCues'], 'readonly',
        async (transaction) => {
          const [marker, cues, checkpoints, unassigned] = await Promise.all([
            request(transaction.objectStore('cueAuthorities').get(meetingId)),
            request(transaction.objectStore('cues').getAll()),
            request(transaction.objectStore('checkpoints').getAll()),
            request(transaction.objectStore('unassignedCues').index('meetingId').getAll(meetingId))
          ]);
          return classifyCueAuthority({ marker,
            cues: cues.filter((item) => item.meetingId === meetingId),
            checkpoints: checkpoints.filter((item) => item.meetingId === meetingId), unassigned });
        });
    },
    async saveCheckpointCursor(input) {
      const incoming = projectLocalCheckpoint(input);
      const database = await openDatabase();
      return runNamedTransaction(database, ['checkpoints', 'retentions'], 'readwrite', async (transaction) => {
        assertLocalRetentionWritable(await request(transaction.objectStore('retentions').get(incoming.meetingId)));
        const store = transaction.objectStore('checkpoints');
        const raw = await request(store.get(incoming.key));
        const existing = raw ? projectLocalCheckpoint(raw) : null;
        const saved = mergeCursorCheckpoint(existing, incoming);
        if (saved !== existing) await request(store.put(saved));
        return saved;
      });
    },
    async listCueConflicts(meetingId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'cueConflicts', 'readonly', async (transaction) =>
        request(transaction.objectStore('cueConflicts').index('meetingId').getAll(meetingId)));
    },
    async upgradeLegacyCues(meetingId) {
      normalizeRequiredString(meetingId, 'meetingId');
      const database = await openDatabase();
      return runNamedTransaction(database,
        ['cues', 'checkpoints', 'unassignedCues', 'legacyCueBackups'], 'readwrite',
        async (transaction) => {
          const backups = transaction.objectStore('legacyCueBackups');
          if (await request(backups.get(meetingId))) return { status: 'upgraded' };
          const checkpointStore = transaction.objectStore('checkpoints');
          const legacy = (await request(checkpointStore.getAll()))
            .filter((item) => item.meetingId === meetingId
              && (item.checkpoint?.finalCues?.length || item.checkpoint?.cueCheckpoint));
          const unassigned = (await request(transaction.objectStore('unassignedCues').getAll()))
            .filter((item) => item.meetingId === meetingId);
          if (unassigned.some((item) => !item.cue?.dismissed)) {
            return { status: 'blocked', reason: 'cue_legacy_unassigned' };
          }
          const cueStore = transaction.objectStore('cues');
          const existingRecords = (await request(cueStore.getAll()))
            .filter((item) => item.meetingId === meetingId).map(projectLocalCue);
          const needsRevisionUpgrade = existingRecords.some((item) => !Number.isSafeInteger(item.cue?.revision));
          if (legacy.length === 0 && !needsRevisionUpgrade) return { status: 'current' };
          const staged = new Map(existingRecords.map((item) => [item.key, item]));
          try {
            for (const record of existingRecords) staged.set(record.key, upgradeLegacyCueRecord(record));
            for (const item of legacy) {
              for (const cue of item.checkpoint.finalCues || []) {
                validateFinalCue(cue);
                const record = projectLocalCue({ meetingId, segmentId: item.segmentId,
                  sessionId: cue.sessionId, cue });
                const original = existingRecords.find((item) => item.key === record.key);
                if (original && !sameCanonicalValue(original.cue, record.cue)) {
                  const newer = mergeFinalCue([cue], original.cue).cue;
                  if (!sameCanonicalValue(newer, original.cue)) throw conflict('cue_legacy_migration_conflict');
                }
                if (!original) staged.set(record.key, upgradeLegacyCueRecord(record));
              }
            }
          } catch {
            return { status: 'blocked', reason: 'cue_legacy_migration_conflict' };
          }
          await request(backups.put({ meetingId, checkpoints: legacy, cues: existingRecords,
            unassigned, at: Date.now() }));
          for (const [key, record] of staged) {
            const original = existingRecords.find((item) => item.key === key);
            if (!original || !sameCanonicalValue(original.cue, record.cue)) await request(cueStore.put(record));
          }
          for (const item of legacy) {
            await request(checkpointStore.put(projectLocalCheckpoint({
              ...item, checkpoint: { ...item.checkpoint, finalCues: [], cueCheckpoint: null,
                cueCursor: { sequence: Math.max(0, ...[...staged.values()]
                  .filter((record) => record.segmentId === item.segmentId)
                  .map((record) => record.sequence)), commitCount: 0 } }
            })));
          }
          return { status: 'upgraded' };
        });
    },
    async getUnassignedCue(meetingId, sessionId, cueId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'unassignedCues', 'readonly', async (transaction) =>
        (await request(transaction.objectStore('unassignedCues').get(unassignedCueKey(meetingId, sessionId, cueId)))) || null);
    },
    async listUnassignedCues(meetingId) {
      normalizeRequiredString(meetingId, 'meetingId');
      const database = await openDatabase();
      return runNamedTransaction(database, 'unassignedCues', 'readonly', async (transaction) =>
        (await request(transaction.objectStore('unassignedCues').index('meetingId').getAll(meetingId)))
          .sort(compareLocalCues));
    },
    async countUnassignedCues(meetingId) {
      normalizeRequiredString(meetingId, 'meetingId');
      const database = await openDatabase();
      return runNamedTransaction(database, 'unassignedCues', 'readonly', async (transaction) =>
        request(transaction.objectStore('unassignedCues').index('meetingId').count(meetingId)));
    },
    async listCues(meetingId, { segmentId } = {}) {
      normalizeRequiredString(meetingId, 'meetingId');
      const database = await openDatabase();
      return runNamedTransaction(database, 'cues', 'readwrite', async (transaction) => {
        const store = transaction.objectStore('cues');
        const records = await request(store.getAll());
        const projected = records.map(projectLocalCue);
        for (let index = 0; index < records.length; index += 1) {
          if (!sameProjection(records[index], projected[index])) await request(store.put(projected[index]));
        }
        return projected
          .filter((record) => record.meetingId === meetingId && (!segmentId || record.segmentId === segmentId))
          .sort(compareLocalCues);
      });
    },
    async saveTranscriptItem(input) {
      const item = projectLocalTranscript(input);
      const database = await openDatabase();
      return runNamedTransaction(database, ['transcripts', 'retentions'], 'readwrite', async (transaction) => {
        assertLocalRetentionWritable(await request(transaction.objectStore('retentions').get(item.meetingId)));
        const store = transaction.objectStore('transcripts');
        const existing = await request(store.get(item.key));
        const saved = mergeLocalTranscript(existing && projectLocalTranscript(existing), item);
        if (!existing || !sameProjection(existing, saved)) await request(store.put(saved));
        return saved;
      });
    },
    async listTranscriptItems(meetingId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'transcripts', 'readonly', async (transaction) =>
        (await request(transaction.objectStore('transcripts').index('meetingId').getAll(meetingId)))
          .map(projectLocalTranscript).sort(compareLocalTranscripts));
    },
    async saveTranslatedAudioChunk(input) {
      const chunk = projectTranslatedAudioChunk(input);
      const database = await openDatabase();
      return runNamedTransaction(database, ['translatedAudioChunks', 'retentions'], 'readwrite', async (transaction) => {
        assertLocalRetentionWritable(await request(transaction.objectStore('retentions').get(chunk.meetingId)));
        const store = transaction.objectStore('translatedAudioChunks');
        const existing = await request(store.get(chunk.key));
        if (existing && !sameCanonicalValue(existing, chunk)) throw conflict('local_translated_audio_conflict');
        if (!existing) await request(store.put(chunk));
        return chunk;
      });
    },
    async listTranslatedAudioChunks(meetingId) {
      normalizeRequiredString(meetingId, 'meetingId');
      const database = await openDatabase();
      return runNamedTransaction(database, 'translatedAudioChunks', 'readonly', async (transaction) =>
        (await request(transaction.objectStore('translatedAudioChunks').index('meetingId').getAll(meetingId)))
          .map(projectTranslatedAudioChunk)
          .sort((left, right) => left.sessionId.localeCompare(right.sessionId) || left.sequence - right.sequence));
    },
    async getCheckpoint(meetingId, segmentId) {
      const key = localCheckpointKey(meetingId, segmentId);
      const database = await openDatabase();
      return runNamedTransaction(database, 'checkpoints', 'readwrite', async (transaction) => {
        const store = transaction.objectStore('checkpoints');
        const raw = await request(store.get(key));
        if (!raw) return null;
        const projected = projectLocalCheckpoint(raw);
        if (!sameProjection(raw, projected)) await request(store.put(projected));
        return projected;
      });
    },
    async listCheckpoints(meetingId) {
      const database = await openDatabase();
      return runNamedTransaction(database, 'checkpoints', 'readonly', async (transaction) =>
        (await request(transaction.objectStore('checkpoints').getAll()))
          .filter((checkpoint) => checkpoint.meetingId === meetingId).map(projectLocalCheckpoint));
    },
    async reserve(input) {
      const record = reserveLocalChunk(input);
      const database = await openDatabase();
      return runNamedTransaction(database, ['chunks', 'retentions'], 'readwrite', async (transaction) => {
        assertLocalRetentionWritable(await request(transaction.objectStore('retentions').get(record.meetingId)));
        const store = transaction.objectStore('chunks');
        const existing = await request(store.get(record.chunkId));
        if (existing) {
          const projected = projectLocalChunk(existing);
          if (!sameChunkIdentity(projected, record)) throw conflict('local_chunk_identity_conflict');
          if (!sameProjection(existing, projected)) await request(store.put(projected));
          return projected;
        }
        const records = await request(store.getAll());
        if (records.some((value) => value.meetingId === record.meetingId && value.sequence === record.sequence)) {
          throw conflict('local_chunk_sequence_conflict');
        }
        await request(store.add(record));
        return record;
      });
    },
    async seal(chunkId, input) {
      const database = await openDatabase();
      return runTransaction(database, 'readwrite', async (store) => {
        const current = await request(store.get(chunkId));
        if (!current) throw invalid(`Unknown local chunk: ${chunkId}.`);
        const next = sealLocalChunk(projectLocalChunk(current), input);
        await request(store.put(next));
        return next;
      });
    },
    async mark(chunkId, state) {
      const database = await openDatabase();
      return runTransaction(database, 'readwrite', async (store) => {
        const current = await request(store.get(chunkId));
        if (!current) throw invalid(`Unknown local chunk: ${chunkId}.`);
        const next = markLocalChunk(projectLocalChunk(current), state);
        await request(store.put(next));
        return next;
      });
    },
    async get(chunkId) {
      const database = await openDatabase();
      return runTransaction(database, 'readwrite', async (store) => {
        const record = await request(store.get(chunkId));
        if (!record) return null;
        const projected = projectLocalChunk(record);
        if (!sameProjection(record, projected)) await request(store.put(projected));
        return projected;
      });
    },
    async list(meetingId) {
      const database = await openDatabase();
      return runTransaction(database, 'readwrite', async (store) => {
        const records = await request(store.getAll());
        const projected = records.map(projectLocalChunk);
        for (let index = 0; index < records.length; index += 1) {
          if (!sameProjection(records[index], projected[index])) await request(store.put(projected[index]));
        }
        return projected
          .filter((record) => meetingId === undefined || record.meetingId === meetingId)
          .sort((left, right) => left.sequence - right.sequence);
      });
    }
  });

  function openDatabase() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const requestHandle = indexedDBImpl.open(dbName, LOCAL_MEETING_DATABASE_VERSION);
        let blocked = false;
        requestHandle.onupgradeneeded = () => {
          const database = requestHandle.result;
          if (!database.objectStoreNames.contains('chunks')) {
            const store = database.createObjectStore('chunks', { keyPath: 'chunkId' });
            store.createIndex('meeting-sequence', ['meetingId', 'sequence'], { unique: true });
          }
          if (!database.objectStoreNames.contains('recordings')) {
            database.createObjectStore('recordings', { keyPath: 'meetingId' });
          }
          if (!database.objectStoreNames.contains('operations')) {
            database.createObjectStore('operations', { keyPath: 'key' });
          }
          if (!database.objectStoreNames.contains('segments')) {
            const store = database.createObjectStore('segments', { keyPath: 'key' });
            store.createIndex('activeMeetingId', 'activeMeetingId', { unique: true });
          }
          if (!database.objectStoreNames.contains('cues')) {
            const store = database.createObjectStore('cues', { keyPath: 'key' });
            store.createIndex('meeting-segment-sequence', ['meetingId', 'segmentId', 'sequence'], { unique: true });
          }
          const cueStore = requestHandle.transaction.objectStore('cues');
          if (!cueStore.indexNames.contains('meeting-cue-id')) {
            cueStore.createIndex('meeting-cue-id', ['meetingId', 'cueId']);
          }
      if (!database.objectStoreNames.contains('cueOperations')) {
        database.createObjectStore('cueOperations', { keyPath: 'key' }).createIndex('meetingId', 'meetingId');
      }
      if (!database.objectStoreNames.contains('cueConflicts')) {
        database.createObjectStore('cueConflicts', { keyPath: 'key' }).createIndex('meetingId', 'meetingId');
      }
      if (!database.objectStoreNames.contains('legacyCueBackups')) {
        database.createObjectStore('legacyCueBackups', { keyPath: 'meetingId' });
      }
      if (!database.objectStoreNames.contains('pendingCues')) {
        database.createObjectStore('pendingCues', { keyPath: 'key' }).createIndex('meetingId', 'meetingId');
      }
      if (!database.objectStoreNames.contains('cueAuthorities')) {
        database.createObjectStore('cueAuthorities', { keyPath: 'meetingId' });
      }
          if (!database.objectStoreNames.contains('unassignedCues')) {
            const store = database.createObjectStore('unassignedCues', { keyPath: 'key' });
            store.createIndex('meetingId', 'meetingId');
          }
          if (!database.objectStoreNames.contains('checkpoints')) {
            database.createObjectStore('checkpoints', { keyPath: 'key' });
          }
          if (!database.objectStoreNames.contains('transcripts')) {
            const store = database.createObjectStore('transcripts', { keyPath: 'key' });
            store.createIndex('meetingId', 'meetingId');
          }
          if (!database.objectStoreNames.contains('translatedAudioChunks')) {
            const store = database.createObjectStore('translatedAudioChunks', { keyPath: 'key' });
            store.createIndex('meetingId', 'meetingId');
          }
          if (!database.objectStoreNames.contains('retentions')) {
            database.createObjectStore('retentions', { keyPath: 'meetingId' });
          }
        };
        requestHandle.onsuccess = () => {
          if (blocked) requestHandle.result.close();
          else resolve(requestHandle.result);
        };
        requestHandle.onerror = () => reject(requestHandle.error || new Error('IndexedDB open failed.'));
        requestHandle.onblocked = () => {
          blocked = true;
          reject(new Error('IndexedDB upgrade is blocked.'));
        };
      });
    }
    return databasePromise;
  }
}

export function createOpfsChunkStore({ rootDirectory = null } = {}) {
  return Object.freeze({
    async write(path, bytes) {
      const { directory, name } = await opfsWriteStep('PARENT_DIRECTORY', () => parentDirectory(rootDirectory, path, true));
      try {
        await opfsWriteStep('FILE_LOOKUP', () => directory.getFileHandle(name, { create: false }));
        throw conflict('local_chunk_file_exists');
      } catch (error) {
        if (error?.code === 'local_chunk_file_exists') throw error;
        if (error?.name !== 'NotFoundError') throw error;
      }
      const file = await opfsWriteStep('FILE_CREATE', () => directory.getFileHandle(name, { create: true }));
      const writable = await opfsWriteStep('WRITABLE_CREATE', () => file.createWritable());
      try {
        await opfsWriteStep('WRITABLE_WRITE', () => writable.write(bytes));
        await opfsWriteStep('WRITABLE_CLOSE', () => writable.close());
      } catch (error) {
        try { await writable.abort?.(); } catch { /* best effort */ }
        throw error;
      }
      return path;
    },
    async read(path) {
      const file = await fileHandle(rootDirectory, path, false);
      return file.getFile();
    },
    async remove(path) {
      const { directory, name } = await parentDirectory(rootDirectory, path, false);
      await directory.removeEntry(name);
    },
    async removeMeeting(meetingId) {
      const name = safePathPart(meetingId, 'meetingId');
      const root = rootDirectory || await globalThis.navigator?.storage?.getDirectory?.();
      if (!root) throw new Error('OPFS is unavailable.');
      let meetings;
      try {
        meetings = await root.getDirectoryHandle('meetings');
      } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
      }
      if (meetings) {
        try {
          await meetings.removeEntry(name, { recursive: true });
        } catch (error) {
          if (error?.name !== 'NotFoundError') throw error;
        }
      }
      let journals;
      try {
        const base = await root.getDirectoryHandle('pcm-journals');
        journals = await base.getDirectoryHandle('v1');
      } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
      }
      if (journals) {
        try {
          await journals.removeEntry(name, { recursive: true });
        } catch (error) {
          if (error?.name !== 'NotFoundError') throw error;
        }
      }
    }
  });
}

async function opfsWriteStep(operation, work) {
  try {
    return await work();
  } catch (error) {
    try { if (error && typeof error === 'object') error.opfsOperation = operation; } catch { /* Preserve the original error. */ }
    throw error;
  }
}

function projectLocalChunk(value) {
  const record = value || {};
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    meetingId: record.meetingId,
    recordingId: record.recordingId || record.meetingId,
    segmentId: record.segmentId,
    chunkId: record.chunkId,
    sequence: record.sequence,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? null,
    byteSize: record.byteSize ?? null,
    checksum: record.checksum ?? null,
    mimeType: record.mimeType,
    path: record.path,
    state: record.state,
    createdAt: record.createdAt,
    sealedAt: record.sealedAt ?? null,
    deleteRequestedAt: record.deleteRequestedAt ?? null
  });
}

function projectLocalRecording(value = {}) {
  return Object.freeze({
    schemaVersion: value.integrityVersion === 2 ? LOCAL_MEETING_SCHEMA_VERSION : (value.schemaVersion || 5),
    meetingId: value.meetingId,
    recordingId: value.recordingId,
    ownerUserId: value.ownerUserId ?? null,
    storageIdentity: value.storageIdentity ?? null,
    segmentId: value.segmentId,
    segmentNumber: normalizeSegmentNumber(value.segmentNumber, value.segmentId),
    integrityVersion: value.integrityVersion === 2 ? 2 : null,
    pcmEnabled: value.integrityVersion === 2 ? value.pcmEnabled === true : null,
    pauseBoundary: value.integrityVersion === 2 ? (value.pauseBoundary ?? null) : null,
    captureEpoch: value.captureEpoch,
    providerEpoch: value.providerEpoch,
    state: value.state,
    finalSequence: value.finalSequence ?? null,
    terminal: value.terminal === true,
    finalized: value.finalized === true
  });
}

function segmentKey(meetingId, segmentId) {
  return `${normalizeRequiredString(meetingId, 'meetingId')}\u0000${normalizeRequiredString(segmentId, 'segmentId')}`;
}

function projectLocalSegment(value = {}) {
  const meetingId = normalizeRequiredString(value.meetingId, 'meetingId');
  const segmentId = normalizeRequiredString(value.segmentId, 'segmentId');
  const status = value.status;
  if (!['ACTIVE', 'ENDED'].includes(status)) throw conflict('local_segment_status_invalid');
  const sequence = normalizePositiveInteger(value.sequence, 'sequence');
  return Object.freeze({ schemaVersion: 1, key: segmentKey(meetingId, segmentId), meetingId,
    recordingId: normalizeRequiredString(value.recordingId, 'recordingId'), segmentId, sequence,
    status, ...(status === 'ACTIVE' ? { activeMeetingId: meetingId } : {}),
    firstJournalEpoch: value.firstJournalEpoch ?? null,
    lastJournalEpoch: value.lastJournalEpoch ?? null,
    endedByOperationId: value.endedByOperationId ?? null,
    provenance: value.provenance === 'native' ? 'native' : 'legacy-unverified' });
}

function initialLocalSegment(recording) {
  return projectLocalSegment({ meetingId: recording.meetingId, recordingId: recording.recordingId,
    segmentId: recording.segmentId, sequence: recording.segmentNumber, status: 'ACTIVE',
    firstJournalEpoch: recording.pcmEnabled ? 1 : null, provenance: 'native' });
}

function projectSegmentTransition(value = {}) {
  const meetingId = normalizeRequiredString(value.meetingId, 'meetingId');
  const operationId = normalizeRequiredString(value.operationId, 'operationId');
  if (!['PREPARED', 'COMMITTED', 'ABORTED'].includes(value.phase)) throw conflict('local_segment_transition_phase_invalid');
  return Object.freeze({ schemaVersion: 2, key: operationKey(meetingId, operationId),
    type: 'local_segment_transition', meetingId, operationId,
    recordingId: normalizeRequiredString(value.recordingId, 'recordingId'),
    predecessorId: normalizeRequiredString(value.predecessorId, 'predecessorId'),
    predecessorSequence: normalizePositiveInteger(value.predecessorSequence, 'predecessorSequence'),
    successorId: normalizeRequiredString(value.successorId, 'successorId'),
    successorSequence: normalizePositiveInteger(value.successorSequence, 'successorSequence'),
    phase: value.phase, boundary: value.boundary ?? null, result: value.result ?? null,
    boundaryOperationId: value.boundaryOperationId ?? null,
    resolutionSegmentId: value.resolutionSegmentId ?? null });
}

function sameSegmentTransitionIdentity(left, right) {
  return left.type === 'local_segment_transition' && left.meetingId === right.meetingId
    && left.operationId === right.operationId && left.recordingId === right.recordingId
    && left.predecessorId === right.predecessorId && left.predecessorSequence === right.predecessorSequence
    && left.successorId === right.successorId && left.successorSequence === right.successorSequence
    && (left.boundaryOperationId ?? null) === (right.boundaryOperationId ?? null);
}

function assertSegmentTransitionSource(recording, transition, predecessor) {
  if (recording?.integrityVersion !== 2 || recording.recordingId !== transition.recordingId
    || recording.segmentId !== transition.predecessorId
    || recording.segmentNumber !== transition.predecessorSequence
    || predecessor?.status !== 'ACTIVE' || predecessor.recordingId !== transition.recordingId
    || predecessor.sequence !== transition.predecessorSequence
    || transition.successorId === transition.predecessorId
    || transition.successorSequence !== transition.predecessorSequence + 1) {
    throw conflict('local_segment_transition_conflict');
  }
  if (transition.boundaryOperationId && (recording.state !== 'paused'
    || recording.pauseBoundary?.transitionOperationId !== transition.boundaryOperationId)) {
    throw conflict('local_segment_pause_boundary_conflict');
  }
}
function assertTransitionBoundary(recording, transition, boundary) {
  if (transition.boundaryOperationId && !sameBoundary(recording.pauseBoundary, boundary)) {
    throw conflict('local_segment_pause_boundary_conflict');
  }
}

function projectSegmentBoundary(value, transition, pcmEnabled) {
  if (value == null) {
    if (pcmEnabled) throw conflict('local_segment_boundary_missing');
    return null;
  }
  if (value.recordingId !== transition.recordingId
    || value.transitionOperationId !== (transition.boundaryOperationId || transition.operationId)
    || !Number.isSafeInteger(value.captureEpoch) || value.captureEpoch < 1
    || !Number.isSafeInteger(value.endSample) || value.endSample < 0
    || !Number.isSafeInteger(value.offset) || value.offset < 0
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw conflict('local_segment_boundary_invalid');
  }
  return Object.freeze({ recordingId: value.recordingId, transitionOperationId: value.transitionOperationId,
    captureEpoch: value.captureEpoch, endSample: value.endSample, offset: value.offset, sha256: value.sha256 });
}

function sameBoundary(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function conflictThrow(code) { throw conflict(code); }

function projectStoredRecordingOperation(value) {
  return value.type === 'local_segment_transition' ? projectSegmentTransition(value) : projectLocalOperation(value);
}

function projectContinueOperation(value = {}) {
  const meetingId = normalizeRequiredString(value.meetingId, 'meetingId');
  const operationId = normalizeRequiredString(value.operationId, 'operationId');
  const sourceSegmentId = normalizeRequiredString(value.sourceSegmentId, 'sourceSegmentId');
  const nextLiveSessionId = normalizeRequiredString(value.nextLiveSessionId, 'nextLiveSessionId');
  const payloadHash = normalizeRequiredString(value.payloadHash, 'payloadHash');
  const timestamp = normalizeRequiredString(value.updatedAt || value.createdAt || new Date().toISOString(), 'updatedAt');
  return Object.freeze({
    schemaVersion: 1,
    key: operationKey(meetingId, operationId),
    type: 'legacy_continue',
    operationId,
    meetingId,
    sourceSegmentId,
    nextLiveSessionId,
    expectedSessionId: value.expectedSessionId ? String(value.expectedSessionId) : null,
    payloadHash,
    checkpoint: value.checkpoint && typeof value.checkpoint === 'object' ? structuredClone(value.checkpoint) : {},
    attempt: Number.isSafeInteger(value.attempt) && value.attempt >= 0 ? value.attempt : 0,
    state: String(value.state || 'pending'),
    committedSuccessor: value.committedSuccessor && typeof value.committedSuccessor === 'object'
      ? structuredClone(value.committedSuccessor)
      : null,
    createdAt: String(value.createdAt || timestamp),
    updatedAt: timestamp
  });
}

function sameContinueIdentity(left, right) {
  return left.operationId === right.operationId
    && left.meetingId === right.meetingId
    && left.sourceSegmentId === right.sourceSegmentId
    && left.nextLiveSessionId === right.nextLiveSessionId
    && left.expectedSessionId === right.expectedSessionId
    && left.payloadHash === right.payloadHash;
}

function projectLocalOperation(value = {}) {
  const meetingId = normalizeRequiredString(value.meetingId, 'meetingId');
  const operationId = normalizeRequiredString(value.operationId, 'operationId');
  return Object.freeze({
    schemaVersion: LOCAL_MEETING_SCHEMA_VERSION,
    key: operationKey(meetingId, operationId),
    meetingId,
    operationId,
    type: normalizeRequiredString(value.type, 'type'),
    result: projectLocalOperationResult(value.result)
  });
}

function projectLocalOperationResult(value = {}) {
  return Object.freeze({
    state: value.state,
    meetingId: value.meetingId,
    recordingId: value.recordingId,
    segmentId: value.segmentId,
    captureEpoch: value.captureEpoch,
    providerEpoch: value.providerEpoch,
    finalSequence: value.finalSequence ?? null,
    stopError: null
  });
}

function projectLocalCue(value = {}) {
  const meetingId = normalizeRequiredString(value.meetingId, 'meetingId');
  const segmentId = normalizeRequiredString(value.segmentId, 'segmentId');
  const sessionId = normalizeRequiredString(value.sessionId, 'sessionId');
  const rawCue = value.cue && typeof value.cue === 'object' ? value.cue : value;
  const cueId = normalizeRequiredString(value.cueId || rawCue.cueId, 'cueId');
  const sequence = normalizePositiveInteger(value.sequence ?? rawCue.sequence, 'sequence');
  if ((rawCue.segmentId != null && rawCue.segmentId !== segmentId)
    || (rawCue.sessionId != null && rawCue.sessionId !== sessionId)
    || (rawCue.sequence != null && rawCue.sequence !== sequence)) {
    throw conflict('local_cue_identity_conflict');
  }
  return Object.freeze({
    schemaVersion: LOCAL_MEETING_SCHEMA_VERSION,
    key: localCueKey(meetingId, segmentId, cueId),
    meetingId,
    sessionId,
    segmentId,
    cueId,
    sequence,
    cue: sanitizeLocalValue(rawCue.revision == null
      ? rawCue
      : { ...rawCue, revision: normalizePositiveInteger(rawCue.revision, 'cue.revision') }),
    producedAt: normalizeOptionalTimestamp(value.producedAt ?? rawCue.finalizedAt, 'producedAt'),
    updatedAt: normalizeOptionalTimestamp(value.updatedAt, 'updatedAt') ?? Date.now()
  });
}

function projectLocalTranscript(value = {}) {
  const meetingId = normalizeRequiredString(value.meetingId, 'meetingId');
  const rawItem = value.item && typeof value.item === 'object' ? value.item : value;
  const sessionId = normalizeRequiredString(value.sessionId || rawItem.sessionId, 'sessionId');
  const id = normalizeRequiredString(value.id || rawItem.id, 'item.id');
  const segmentId = value.segmentId ?? rawItem.segmentId ?? null;
  if (segmentId !== null) normalizeRequiredString(segmentId, 'segmentId');
  if (value.segmentId != null && rawItem.segmentId != null && value.segmentId !== rawItem.segmentId) {
    throw conflict('local_transcript_segment_conflict');
  }
  const sequence = normalizePositiveInteger(value.sequence ?? rawItem.sequence, 'item.sequence');
  if (!['source', 'translation'].includes(rawItem.stream) || typeof rawItem.text !== 'string') {
    throw invalid('Transcript stream and text are required.');
  }
  return Object.freeze({
    schemaVersion: LOCAL_MEETING_SCHEMA_VERSION,
    key: `${meetingId}\u0000${sessionId}\u0000${id}`,
    meetingId, sessionId, segmentId, id, sequence,
    revision: value.revision ?? rawItem.revision ?? null,
    sourceText: rawItem.stream === 'source' ? rawItem.text : null,
    translatedText: rawItem.stream === 'translation' ? rawItem.text : null,
    item: sanitizeLocalValue(rawItem)
  });
}

function mergeLocalTranscript(existing, incoming) {
  if (!existing) return { ...incoming, revision: incoming.revision ?? 1 };
  if (existing.sequence !== incoming.sequence || existing.item.stream !== incoming.item.stream
    || (existing.segmentId && incoming.segmentId !== existing.segmentId)) {
    throw conflict('local_transcript_identity_conflict');
  }
  if (sameCanonicalValue(existing.item, incoming.item) && existing.segmentId === incoming.segmentId) {
    return incoming.revision != null && incoming.revision > existing.revision
      ? { ...incoming, revision: incoming.revision } : existing;
  }
  const revision = incoming.revision ?? existing.revision + 1;
  if (revision <= existing.revision) throw conflict('local_transcript_stale_revision');
  return { ...incoming, revision };
}

function compareLocalTranscripts(left, right) {
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}

// Project pre-B2 unassigned records for isolated read-only access.
function projectUnassignedCue(value = {}) {
  const meetingId = normalizeRequiredString(value.meetingId, 'meetingId');
  const sessionId = normalizeRequiredString(value.sessionId, 'sessionId');
  const cueId = normalizeRequiredString(value.cueId, 'cueId');
  const sequence = normalizePositiveInteger(value.sequence, 'sequence');
  const revision = normalizePositiveInteger(value.revision, 'revision');
  const reason = normalizeRequiredString(value.reason, 'reason');
  const rawCue = value.cue;
  if (!rawCue || typeof rawCue !== 'object' || Array.isArray(rawCue)) throw invalid('cue is required.');
  if (value.segmentId != null || rawCue.segmentId != null) throw invalid('Unassigned Cue must have no segmentId.');
  if (rawCue.revision != null && rawCue.revision !== revision) {
    throw invalid('Unassigned Cue revision does not match its record.');
  }
  if (rawCue.cueId !== cueId || rawCue.sessionId !== sessionId || rawCue.sequence !== sequence) {
    throw invalid('Unassigned Cue identity does not match its record.');
  }
  if (rawCue.status !== 'partial' && rawCue.status !== 'final') throw invalid('cue.status must be partial or final.');
  const startTimeMs = normalizeTimestamp(rawCue.startTimeMs, 'cue.startTimeMs');
  const endTimeMs = normalizeTimestamp(rawCue.endTimeMs, 'cue.endTimeMs');
  if (endTimeMs < startTimeMs) throw invalid('cue.endTimeMs precedes cue.startTimeMs.');
  return Object.freeze({
    schemaVersion: UNASSIGNED_CUE_SCHEMA_VERSION,
    key: unassignedCueKey(meetingId, sessionId, cueId),
    meetingId, sessionId, cueId, segmentId: null, sequence, revision, reason,
    allocationFloor: Math.max(sequence + 1,
      Number.isSafeInteger(value.allocationFloor) ? value.allocationFloor : 1),
    sourceIdentity: projectUnassignedSourceIdentity(value.sourceIdentity),
    cue: sanitizeLocalValue({ ...rawCue, segmentId: null, revision }),
    updatedAt: normalizeOptionalTimestamp(value.updatedAt, 'updatedAt') ?? Date.now()
  });
}

function projectUnassignedSourceIdentity(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw invalid('sourceIdentity must be an object.');
  const stringFields = new Set(['liveSessionId', 'eventId', 'audioTurnId', 'turnKey']);
  const integerFields = new Set(['connectionEpoch', 'providerEpoch', 'eventSequence', 'turnIndex']);
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue;
    if (stringFields.has(key)) result[key] = normalizeRequiredString(value, `sourceIdentity.${key}`);
    else if (integerFields.has(key)) result[key] = normalizeNonNegativeInteger(value, `sourceIdentity.${key}`);
    else throw invalid(`Unsupported sourceIdentity field: ${key}.`);
  }
  return Object.keys(result).length ? Object.freeze(result) : null;
}

function upgradeLegacyCueRecord(record) {
  if (Number.isSafeInteger(record.cue?.revision) && record.cue.revision > 0) return record;
  if (record.cue?.status !== 'final') throw conflict('cue_legacy_migration_conflict');
  const cue = { ...record.cue, revision: 1 };
  validateFinalCue(cue);
  return projectLocalCue({ ...record, cue });
}

function cueRejectionRecord(input, reason, existing) {
  const meetingId = normalizeRequiredString(input.meetingId, 'meetingId');
  const segmentId = normalizeRequiredString(input.segmentId, 'segmentId');
  const eventKey = normalizeRequiredString(input.eventKey, 'eventKey');
  return Object.freeze({
    key: JSON.stringify([meetingId, segmentId, eventKey]), meetingId, segmentId,
    cueId: input.cue?.cueId ?? null, eventKey, reason, at: Date.now(),
    storedCue: existing?.cue ?? null, incomingCue: input.cue ?? null
  });
}

function recordCueRejection(conflicts, input, reason, existing) {
  const item = cueRejectionRecord(input, reason, existing);
  conflicts.set(item.key, item);
  for (const old of [...conflicts.values()].filter((value) => value.meetingId === item.meetingId)
    .sort((a, b) => a.at - b.at).slice(0, Math.max(0,
      [...conflicts.values()].filter((value) => value.meetingId === item.meetingId).length - 100))) {
    conflicts.delete(old.key);
  }
  return { status: 'rejected', reason };
}

function assertLocalRetentionWritable(retention) {
  if (retention?.deleted || retention?.physicalCleared
    || (retention?.expiresAt && Date.parse(retention.expiresAt) <= Date.now())) {
    throw conflict('meeting_content_expired');
  }
}

function sameCanonicalValue(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function mergeCursorCheckpoint(existing, incoming) {
 const payload = incoming.checkpoint;
 if (payload.finalCues?.length || payload.cueCheckpoint || payload.refinedSubtitleCues?.length) {
  throw conflict('local_checkpoint_cue_content_forbidden');
 }
 const cursorOnly = projectLocalCheckpoint({
  ...incoming,
  checkpoint: { ...payload, finalCues: [], cueCheckpoint: null, refinedSubtitleCues: [] }
 });
 if (typeof payload.idempotencyKey !== 'string' || !payload.idempotencyKey) {
  if (existing) throw checkpointConflict('legacy checkpoint update has no operation key');
  return cursorOnly;
 }
 const operation = checkCheckpointOperation(existing?.checkpoint, payload);
 const merged = operation.duplicate ? existing.checkpoint : mergeCheckpoint({
  existing: existing?.checkpoint,
  incoming: { ...cursorOnly.checkpoint,
   durableChunks: Array.isArray(payload.durableChunks) ? payload.durableChunks : [] },
  meetingId: incoming.meetingId,
  segmentId: incoming.segmentId,
  updatedAt: incoming.updatedAt,
  verifiedLegacyCueIds: new Set()
 });
 const clean = { ...merged, finalCues: [], cueCheckpoint: null, refinedSubtitleCues: [] };
 if (existing?.checkpoint?.cueCursor) clean.cueCursor = existing.checkpoint.cueCursor;
 return projectLocalCheckpoint({ ...incoming,
  checkpoint: operation.duplicate ? clean
   : recordCheckpointOperation(existing?.checkpoint, payload, clean, operation.canonical) });
}

function projectLocalCheckpoint(value = {}) {
  const meetingId = normalizeRequiredString(value.meetingId, 'meetingId');
  const segmentId = normalizeRequiredString(value.segmentId, 'segmentId');
  const rawCheckpoint = value.checkpoint && typeof value.checkpoint === 'object'
    ? value.checkpoint
    : Object.fromEntries(Object.entries(value).filter(([key]) => !['key', 'schemaVersion', 'meetingId', 'segmentId', 'updatedAt'].includes(key)));
  return Object.freeze({
    schemaVersion: LOCAL_MEETING_SCHEMA_VERSION,
    key: localCheckpointKey(meetingId, segmentId),
    meetingId,
    segmentId,
    checkpoint: sanitizeLocalValue(rawCheckpoint),
    updatedAt: normalizeOptionalTimestamp(value.updatedAt, 'updatedAt') ?? Date.now()
  });
}

function sanitizeLocalValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => sanitizeLocalValue(item, seen));
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) throw invalid('Local persistence value must not be cyclic.');
  seen.add(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (isCredentialField(key)) continue;
    result[key] = sanitizeLocalValue(item, seen);
  }
  seen.delete(value);
  return Object.freeze(result);
}

function isCredentialField(key) {
  return /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|ephemeral[_-]?token|authorization|credential|jwt|secret)/iu.test(key);
}

function localCueKey(meetingId, segmentId, cueId) {
  return `${normalizeRequiredString(meetingId, 'meetingId')}\u0000${normalizeRequiredString(segmentId, 'segmentId')}\u0000${normalizeRequiredString(cueId, 'cueId')}`;
}

function unassignedCueKey(meetingId, sessionId, cueId) {
  return JSON.stringify([
    normalizeRequiredString(meetingId, 'meetingId'),
    normalizeRequiredString(sessionId, 'sessionId'),
    normalizeRequiredString(cueId, 'cueId')
  ]);
}

function localCheckpointKey(meetingId, segmentId) {
  return `${normalizeRequiredString(meetingId, 'meetingId')}\u0000${normalizeRequiredString(segmentId, 'segmentId')}`;
}

function sameCueIdentity(left, right) {
  return left.meetingId === right.meetingId && left.sessionId === right.sessionId &&
    left.segmentId === right.segmentId && left.cueId === right.cueId && left.sequence === right.sequence;
}

function compareLocalCues(left, right) {
  return left.sequence - right.sequence || left.cueId.localeCompare(right.cueId);
}

function operationKey(meetingId, operationId) {
  return `${normalizeRequiredString(meetingId, 'meetingId')}\u0000${normalizeRequiredString(operationId, 'operationId')}`;
}

function normalizeSegmentNumber(value, segmentId) {
  if (Number.isSafeInteger(Number(value)) && Number(value) > 0) return Number(value);
  const match = String(segmentId || '').match(/:(\d+)$/u);
  return match ? Number(match[1]) : 1;
}

function sameProjection(raw, projected) {
  return JSON.stringify(raw) === JSON.stringify(projected);
}

function sameChunkIdentity(left, right) {
  return left.meetingId === right.meetingId &&
    (left.recordingId || left.meetingId) === (right.recordingId || right.meetingId) &&
    left.segmentId === right.segmentId &&
    left.chunkId === right.chunkId &&
    left.sequence === right.sequence &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt &&
    left.byteSize === right.byteSize &&
    left.checksum === right.checksum &&
    left.mimeType === right.mimeType &&
    left.path === right.path;
}

function matchesExpectedFile(record, file) {
  return Number(file.byteSize) === Number(record.byteSize) &&
    String(file.checksum || '') === String(record.checksum || '');
}

function getRecord(records, chunkId) {
  const value = records.get(chunkId);
  if (!value) throw invalid(`Unknown local chunk: ${chunkId}.`);
  return value;
}

function assertChunkRecord(record) {
  if (!record || typeof record !== 'object' || !STATE_SET.has(record.state)) throw invalid('Invalid local chunk record.');
}

function extensionForMimeType(mimeType) {
  return String(mimeType || '').toLowerCase().includes('ogg') ? 'ogg' : 'webm';
}

function normalizeMimeType(value) {
  const mimeType = normalizeRequiredString(value, 'mimeType');
  if (!/^audio\/[a-z0-9.+-]+(?:;[^\s]+)?$/iu.test(mimeType)) throw invalid('mimeType must be an audio MIME type.');
  return mimeType;
}

function normalizeTimestamp(value, field) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp < 0) throw invalid(`${field} must be a non-negative timestamp.`);
  return timestamp;
}

function normalizeOptionalTimestamp(value, field) {
  return value === null || value === undefined ? null : normalizeTimestamp(value, field);
}

function normalizePositiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw invalid(`${field} must be a positive integer.`);
  return number;
}

function normalizeNonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw invalid(`${field} must be a non-negative integer.`);
  return number;
}

function normalizeOptionalNonNegativeInteger(value, field) {
  return value === null || value === undefined ? null : normalizeNonNegativeInteger(value, field);
}

function normalizeRequiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${field} is required.`);
  return value.trim();
}

function normalizeOptionalString(value, field) {
  if (value === null || value === undefined || value === '') return null;
  return normalizeRequiredString(value, field);
}

function safePathPart(value, field) {
  const part = normalizeRequiredString(value, field);
  if (!/^[a-z0-9][a-z0-9._:-]*$/iu.test(part)) throw invalid(`${field} contains unsafe path characters.`);
  return part;
}

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'invalid_request';
  return error;
}

function conflict(code) {
  const error = new Error(code);
  error.code = code;
  error.status = 409;
  return error;
}

async function fileHandle(rootDirectory, path, create) {
  const { directory, name } = await parentDirectory(rootDirectory, path, create);
  return directory.getFileHandle(name, { create });
}

async function parentDirectory(rootDirectory, path, create) {
  const resolvedRoot = rootDirectory || await globalThis.navigator?.storage?.getDirectory?.();
  if (!resolvedRoot || typeof resolvedRoot.getDirectoryHandle !== 'function') throw new Error('OPFS is unavailable.');
  const parts = String(path || '').split('/').filter(Boolean);
  const name = parts.pop();
  if (!name || parts.some((part) => part === '.' || part === '..')) throw invalid('Invalid OPFS path.');
  let directory = resolvedRoot;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return { directory, name };
}

const transactionFailureStates = new WeakMap();

export function localTransactionFailureState(error) {
  return error && typeof error === 'object' ? transactionFailureStates.get(error) ?? null : null;
}

function request(requestHandle) {
  return new Promise((resolve, reject) => {
    requestHandle.onsuccess = () => resolve(requestHandle.result);
    requestHandle.onerror = () => reject(requestHandle.error || new Error('IndexedDB request failed.'));
  });
}

async function runNamedTransaction(database, storeNames, mode, operation) {
  const transaction = database.transaction(storeNames, mode);
  let transactionState = 'active';
  const completion = new Promise((resolve, reject) => {
    transaction.oncomplete = () => { transactionState = 'complete'; resolve(); };
    transaction.onerror = (event) => {
      transactionState = 'error';
      const error = transaction.error || event?.target?.error || new Error('IndexedDB transaction failed.');
      transactionFailureStates.set(error, 'error');
    };
    transaction.onabort = (event) => {
      transactionState = 'aborted';
      const error = transaction.error || event?.target?.error || new Error('IndexedDB transaction aborted.');
      transactionFailureStates.set(error, 'aborted');
      reject(error);
    };
  });
  try {
    const result = await operation(transaction);
    await completion;
    return result;
  } catch (error) {
    try { transaction.abort(); } catch { /* already completed */ }
    await completion.catch(() => {});
    if (error && typeof error === 'object') {
      transactionFailureStates.set(error, transactionState === 'active' ? 'operation_rejected' : transactionState);
    }
    throw error;
  }
}

async function runTransaction(database, mode, operation) {
  const transaction = database.transaction('chunks', mode);
  const completion = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
  });
  try {
    const result = await operation(transaction.objectStore('chunks'));
    await completion;
    return result;
  } catch (error) {
    await completion.catch(() => {});
    throw error;
  }
}
