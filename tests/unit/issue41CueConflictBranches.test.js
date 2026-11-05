import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeFinalCue } from '../../src/domain/subtitleCue/index.js';
import { cueRefinementInputHash } from '../../src/lib/cueContent.js';
import { commitSubtitleCueState, createSubtitleCueState } from '../../src/lib/subtitleCues.js';
import { createMeetingCheckpointSyncCoordinator } from '../../src/lib/meetingCheckpointSyncCoordinator.js';

const cue = (changes = {}) => ({
  cueId: 'cue-1', sessionId: 'session-1', segmentId: 'segment-1', sequence: 1,
  startTimeMs: 0, endTimeMs: 100,
  sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en',
  sourceText: 'source fixture', translatedText: 'translation fixture',
  sourceVersion: 1, translationVersion: 1,
  status: 'final', finalizedReason: 'turnComplete', revision: 1,
  ...changes
});

const legacy = (changes = {}) => {
  const result = cue(changes);
  delete result.revision;
  return result;
};

for (const { name, existing, incoming, reason } of [
  {
    name: 'equal revision with different state',
    existing: cue(), incoming: cue({ finalizedReason: 'merged' }),
    reason: 'same_revision_payload_mismatch'
  },
  {
    name: 'revisionless incoming Cue after a versioned Cue',
    existing: cue(), incoming: legacy({ finalizedReason: 'merged' }),
    reason: 'incoming_revision_missing'
  },
  {
    name: 'newer revision with a side version regression',
    existing: cue(), incoming: cue({ revision: 2, sourceVersion: 0 }),
    reason: 'versioned_state_regression'
  },
  {
    name: 'legacy reason change without durable proof',
    existing: legacy(), incoming: cue({ revision: 2, finalizedReason: 'merged' }),
    reason: 'legacy_reason_unverified'
  },
  {
    name: 'newer revision with an unsupported payload change',
    existing: cue(), incoming: cue({ revision: 2, endTimeMs: 101 }),
    reason: 'payload_conflict'
  }
]) {
  test(`Cue conflict reason identifies ${name}`, () => {
    assert.throws(() => mergeFinalCue([existing], incoming), (error) => {
      assert.equal(error.code, 'subtitle_cue_conflict');
      assert.equal(error.rejectReason, reason);
      assert.equal(error.cueConflict.cueId, 'cue-1');
      assert.equal(error.cueConflict.existingRevision, existing.revision ?? null);
      assert.equal(error.cueConflict.incomingRevision, incoming.revision ?? null);
      assert.equal(error.cueConflict.identitySame, true);
      assert.equal('sourceText' in error.cueConflict, false);
      assert.equal('translatedText' in error.cueConflict, false);
      assert.equal('inputHash' in error.cueConflict.refinement, false);
      return true;
    });
  });
}

test('valid newer reason-only revision still merges', () => {
  const result = mergeFinalCue([cue()], cue({ revision: 2, finalizedReason: 'merged' }));
  assert.equal(result.updated, true);
  assert.equal(result.cue.revision, 2);
});

test('Cue Engine accepted late-final refinement reset merges with a newer revision', () => {
  const existing = cue({ rawSource: 'source fixture', rawTranslation: 'translation fixture',
    refinement: { status: 'pending', version: 1 } });
  const proposed = cue({ sourceVersion: 2, sourceText: 'source fixture extended',
    rawSource: 'source fixture extended', rawTranslation: 'translation fixture',
    finalizedReason: 'merged', refinement: { status: 'pending', version: 1 } });
  const previous = createSubtitleCueState({ finalCues: [existing] });
  const transition = commitSubtitleCueState(previous, { ...previous, finalCues: [proposed] });
  assert.equal(transition.accepted, true);
  const incoming = transition.state.finalCues[0];
  assert.equal(incoming.revision, 2);
  assert.equal(incoming.refinement.status, 'pending');
  const result = mergeFinalCue([existing], incoming);
  assert.equal(result.updated, true);
  assert.equal(result.cue.revision, 2);
  assert.equal(result.cue.rawSource, 'source fixture extended');
  assert.equal(result.cue.finalizedReason, 'merged');
});

test('Browser revision 3 to 4 accepts a late translation input reset', () => {
  const existing = cue({ revision: 3, translationVersion: 2,
    rawSource: 'source fixture', rawTranslation: 'translation fixture',
    initialTranslation: 'translation fixture',
    refinement: { status: 'pending', version: 1 } });
  const previous = createSubtitleCueState({ finalCues: [existing] });
  const proposed = { ...existing, translatedText: 'translation fixture extended',
    rawTranslation: 'translation fixture extended', translationVersion: 3,
    initialTranslation: 'translation fixture extended',
    finalizedReason: 'merged' };
  const transition = commitSubtitleCueState(previous, { ...previous, finalCues: [proposed] });
  assert.equal(transition.accepted, true);
  const incoming = transition.state.finalCues[0];
  assert.equal(incoming.revision, 4);
  assert.equal(incoming.sourceVersion, existing.sourceVersion);
  assert.ok(incoming.translationVersion > existing.translationVersion);
  assert.equal(incoming.refinement.version, 1);
  assert.equal(incoming.refinement.status, 'pending');
  assert.notEqual(incoming.refinement.inputHash, cueRefinementInputHash(existing));
  assert.equal(incoming.refinement.inputHash, cueRefinementInputHash(incoming));
  const result = mergeFinalCue([existing], incoming, { verifiedLegacyReasonUpdate: true });
  assert.equal(result.updated, true);
  assert.equal(result.cue.revision, 4);
  assert.equal(result.cue.translatedText, 'translation fixture extended');
  assert.equal(result.cue.initialTranslation, 'translation fixture extended');
  assert.equal(result.cue.finalizedReason, 'merged');
});

test('newer translation input cannot excuse a forged refinement hash', () => {
  const existing = cue({ revision: 3, translationVersion: 2,
    rawSource: 'source fixture', rawTranslation: 'translation fixture',
    refinement: { status: 'pending', version: 1 } });
  const incoming = cue({ revision: 4, translationVersion: 3,
    translatedText: 'translation fixture extended', rawSource: 'source fixture',
    rawTranslation: 'translation fixture extended', finalizedReason: 'merged',
    refinement: { status: 'pending', version: 1, inputHash: 'forged-hash' } });
  assert.throws(() => mergeFinalCue([existing], incoming),
    (error) => error.rejectReason === 'versioned_state_regression');
});

test('newer Cue revision still rejects unsupported refinement reset and side regression', () => {
  const existing = cue({ rawSource: 'source fixture', rawTranslation: 'translation fixture',
    refinement: { status: 'completed', version: 2 }, refinedTranslation: 'refined fixture' });
  assert.throws(() => mergeFinalCue([existing], cue({ revision: 2, rawSource: 'source fixture',
    rawTranslation: 'translation fixture', refinement: { status: 'pending', version: 1 } })),
  (error) => error.rejectReason === 'versioned_state_regression');
  assert.throws(() => mergeFinalCue([existing], cue({ revision: 2, sourceVersion: 0,
    rawSource: 'source fixture', rawTranslation: 'translation fixture',
    refinement: { status: 'completed', version: 2 }, refinedTranslation: 'refined fixture' })),
  (error) => error.rejectReason === 'versioned_state_regression');
});

test('Coordinator emits only metadata from a Cue merge rejection', async () => {
  const diagnostics = [];
  const coordinator = createMeetingCheckpointSyncCoordinator({
    updateCheckpoint: async () => mergeFinalCue([cue()], cue({ finalizedReason: 'merged' })),
    onDiagnostic: (entry) => diagnostics.push(entry),
    setTimeoutFn: () => 1, clearTimeoutFn: () => {}
  });
  coordinator.start({ meetingId: 'meeting-1', segmentId: 'segment-1' });
  coordinator.enqueueCues([cue()]);
  assert.equal(await coordinator.flush(), false);
  assert.equal(diagnostics[0].reason, 'flush_pending_write_exception');
  assert.equal(diagnostics[0].rejectReason, 'same_revision_payload_mismatch');
  assert.equal(diagnostics[0].cueConflict.cueId, 'cue-1');
  assert.equal(JSON.stringify(diagnostics[0]).includes('source fixture'), false);
  assert.equal(JSON.stringify(diagnostics[0]).includes('translation fixture'), false);
});
