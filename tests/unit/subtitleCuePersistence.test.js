import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemorySessionRepository } from '../../src/lib/sessionRepository.js';
import { createMemoryMeetingRepository } from '../../src/infrastructure/meetingRepositoryAdapter.js';
import { createSubtitleCueRepository } from '../../src/repositories/subtitleCueRepository.js';

test('persists final cues idempotently and rejects conflicting identity', async () => {
  const { sessions, meetings } = await fixture();
  const repository = createSubtitleCueRepository({ sessionRepository: sessions, meetingRepository: meetings });
  const cue = finalCue();
  assert.equal((await repository.appendFinalCue(cue)).appended, true);
  assert.equal((await repository.appendFinalCue(cue)).appended, false);
  await assert.rejects(repository.appendFinalCue({ ...cue, translatedText: 'different' }), (error) => error.code === 'subtitle_cue_conflict');
  await assert.rejects(repository.appendFinalCue({ ...cue, cueId: 'cue:other', translatedText: 'other' }), (error) => error.code === 'subtitle_cue_sequence_conflict');
  assert.deepEqual((await repository.listFinalCuesBySession('session-1')).map((item) => item.cueId), ['cue:session-1:segment-1:1']);
});

test('persists a monotonic merged update for an existing final cue', async () => {
  const { sessions, meetings } = await fixture();
  const repository = createSubtitleCueRepository({ sessionRepository: sessions, meetingRepository: meetings });
  const cue = finalCue();
  await repository.appendFinalCue(cue);

  const merged = await repository.appendFinalCue({
    ...cue,
    sourceText: '你好世界',
    translatedText: 'hello world',
    endTimeMs: 200,
    finalizedReason: 'merged'
  });

  assert.equal(merged.appended, true);
  assert.equal((await repository.listFinalCuesBySession('session-1'))[0].sourceText, '你好世界');
});

test('persists source-only final cues while translation reads remain empty', async () => {
  const { sessions, meetings } = await fixture();
  const repository = createSubtitleCueRepository({ sessionRepository: sessions, meetingRepository: meetings });
  const cue = finalCue({ translatedText: '', finalizedReason: 'idle-source-only' });
  const result = await repository.appendFinalCue(cue);
  assert.equal(result.appended, true);
  assert.equal(result.cue.sourceText, '你好');
  assert.equal(result.cue.translatedText, '');
});

test('checkpoint saves and reloads recovery-only cue state', async () => {
  const { sessions, meetings } = await fixture();
  const repository = createSubtitleCueRepository({ sessionRepository: sessions, meetingRepository: meetings });
  const checkpoint = { currentCue: { cueId: 'partial', status: 'partial' }, pendingCues: [], nextSequence: 2, finalizedCueKeys: ['key-1'], processedEventIds: ['event-1'], pendingBoundary: { turnComplete: false, generationComplete: true }, pendingBoundaryAtMs: null, lastFinalizedCueId: null, lastFinalizedAtMs: null, lastFinalizedStream: null, lastFinalizedReason: null, lastCommittedCueSequence: 1, lastCommittedEndTimeMs: 100 };
  await repository.saveCueCheckpoint('session-1', checkpoint);
  assert.deepEqual(await repository.loadCueCheckpoint('session-1'), checkpoint);
});

test('refined Cue update is version fenced and idempotently persists refined values', async () => {
  const { sessions, meetings } = await fixture();
  const repository = createSubtitleCueRepository({ sessionRepository: sessions, meetingRepository: meetings });
  const cue = finalCue({ refinement: { status: 'queued', version: 1, inputHash: 'hash-1' } });
  await repository.appendFinalCue(cue);
  const applied = await repository.updateRefinedCue({
    sessionId: cue.sessionId, cueId: cue.cueId, version: 1, inputHash: 'hash-1',
    refinedSource: 'refined source', refinedTranslation: 'refined translation', completedAt: '2026-08-17T00:00:00.000Z'
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.cue.refinedTranslation, 'refined translation');
  const stale = await repository.updateRefinedCue({
    sessionId: cue.sessionId, cueId: cue.cueId, version: 1, inputHash: 'old-hash',
    refinedSource: 'stale', refinedTranslation: 'stale'
  });
  assert.equal(stale.stale, true);
});

test('persisted refinement wins over a later stale full Cue snapshot', async () => {
  const { sessions, meetings } = await fixture();
  const repository = createSubtitleCueRepository({ sessionRepository: sessions, meetingRepository: meetings });
  const cue = finalCue({ refinement: { status: 'pending', version: 1, inputHash: 'hash-1' } });
  await repository.appendFinalCue(cue);

  await repository.updateRefinedCue({
    sessionId: cue.sessionId,
    cueId: cue.cueId,
    version: 1,
    inputHash: 'hash-1',
    refinedTranslation: 'persisted revision'
  });
  await repository.appendFinalCue(cue);

  const reloaded = await repository.listFinalCuesBySession(cue.sessionId);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].cueId, cue.cueId);
  assert.equal(reloaded[0].refinedTranslation, 'persisted revision');
  assert.equal(reloaded[0].refinement.status, 'completed');
  assert.equal(reloaded[0].sequence, cue.sequence);
});

test('refinement results update addressed Cues in place, including out-of-order polished items', async () => {
  const { sessions, meetings } = await fixture();
  const segment = await meetings.getMeetingSegment('segment-1');
  await meetings.updateMeetingSegment(segment.withCheckpoint({
    ...(segment.checkpoint || {}),
    finalCues: [
      finalCue({ cueId: 'cue-a', sequence: 1, endTimeMs: 100, refinement: { status: 'queued', version: 1, inputHash: 'hash-a' } }),
      finalCue({ cueId: 'cue-b', sequence: 2, startTimeMs: 100, endTimeMs: 200, refinement: { status: 'queued', version: 1, inputHash: 'hash-b' } })
    ]
  }));
  const repository = createSubtitleCueRepository({ sessionRepository: sessions, meetingRepository: meetings });
  const result = await repository.applyRefinementResults({
    sessionId: 'session-1', refinementJobId: 'job-1', requestId: 'request-1',
    results: [
      { targetCueId: 'cue-b', cueId: 'cue-b', sequence: 2, version: 1, inputHash: 'hash-b', polishedText: 'B revised', fields: ['translation'] },
      { targetCueId: 'cue-a', cueId: 'cue-a', sequence: 1, version: 1, inputHash: 'hash-a', polishedText: 'A revised', fields: ['translation'] }
    ],
    completedAt: '2026-08-19T00:00:00.000Z'
  });
  assert.equal(result.applied, true);
  const cues = await repository.listFinalCuesBySession('session-1');
  assert.deepEqual(cues.map(({ cueId, sequence, startTimeMs, endTimeMs, refinedTranslation }) => ({ cueId, sequence, startTimeMs, endTimeMs, refinedTranslation })), [
    { cueId: 'cue-a', sequence: 1, startTimeMs: 0, endTimeMs: 100, refinedTranslation: 'A revised' },
    { cueId: 'cue-b', sequence: 2, startTimeMs: 100, endTimeMs: 200, refinedTranslation: 'B revised' }
  ]);
  assert.equal(cues.every((cue) => cue.refinement.status === 'completed'), true);
});

test('missing refinement target does not append a Cue and emits diagnostic data', async () => {
  const { sessions, meetings } = await fixture();
  const repository = createSubtitleCueRepository({ sessionRepository: sessions, meetingRepository: meetings });
  const diagnostics = [];
  const result = await repository.applyRefinementResults({
    sessionId: 'session-1', refinementJobId: 'job-1', requestId: 'request-1', logger: (event) => diagnostics.push(event),
    results: [{ targetCueId: 'missing-cue', polishedText: 'ignored', fields: ['translation'] }]
  });
  assert.deepEqual(result.results[0], { applied: false, reason: 'target_not_found', targetCueId: 'missing-cue' });
  assert.equal(diagnostics[0].targetCueId, 'missing-cue');
  assert.deepEqual(await repository.listFinalCuesBySession('session-1'), []);
});

test('persists source-only Cue and merges delayed translation into the same Cue ID', async () => {
  const { sessions, meetings } = await fixture();
  const repository = createSubtitleCueRepository({ sessionRepository: sessions, meetingRepository: meetings });
  const sourceOnly = finalCue({
    translatedText: '',
    sourceStatus: 'finalized',
    translationStatus: 'pending',
    sourceVersion: 1,
    translationVersion: 0
  });
  await repository.appendFinalCue(sourceOnly);
  await repository.appendFinalCue({
    ...sourceOnly,
    translatedText: 'hello',
    translationStatus: 'finalized',
    translationVersion: 1
  });

  const cues = await repository.listFinalCuesBySession('session-1');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].cueId, sourceOnly.cueId);
  assert.equal(cues[0].translatedText, 'hello');
  assert.equal(cues[0].translationStatus, 'finalized');
});

test('persists translation-only Cue and merges delayed source into the same Cue ID', async () => {
  const { sessions, meetings } = await fixture();
  const repository = createSubtitleCueRepository({ sessionRepository: sessions, meetingRepository: meetings });
  const translationOnly = finalCue({
    sourceText: '',
    translatedText: 'hello',
    sourceStatus: 'pending',
    translationStatus: 'finalized',
    sourceVersion: 0,
    translationVersion: 1
  });
  await repository.appendFinalCue(translationOnly);
  await repository.appendFinalCue({
    ...translationOnly,
    sourceText: '你好',
    sourceStatus: 'finalized',
    sourceVersion: 1
  });

  const cues = await repository.listFinalCuesBySession('session-1');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].cueId, translationOnly.cueId);
  assert.equal(cues[0].sourceText, '你好');
  assert.equal(cues[0].sourceStatus, 'finalized');
});

test('partial, punctuation-only, and invalid timeline cues are rejected', async () => {
  const { sessions, meetings } = await fixture();
  const repository = createSubtitleCueRepository({ sessionRepository: sessions, meetingRepository: meetings });
  await assert.rejects(repository.appendFinalCue({ ...finalCue(), status: 'partial' }), /Only final cues/);
  await assert.rejects(repository.appendFinalCue({ ...finalCue(), sourceText: '!!!' }), /non-punctuation/);
  await repository.appendFinalCue(finalCue());
  await assert.rejects(repository.appendFinalCue({ ...finalCue(), cueId: 'cue:2', sequence: 2, startTimeMs: 90, endTimeMs: 120 }), /overlaps/);
});

async function fixture() {
  const sessions = createMemorySessionRepository({ now: () => 1 });
  const meetings = createMemoryMeetingRepository();
  await meetings.createMeeting({ id: 'meeting-1', createdAt: 1 });
  await meetings.updateMeeting((await meetings.getMeeting('meeting-1')).activate(1));
  const segment = await meetings.createMeetingSegment({ id: 'segment-1', meetingId: 'meeting-1', sequence: 0, createdAt: 1 });
  await meetings.updateMeetingSegment(segment.activate(1));
  sessions.createSessionRecord({ id: 'session-1', startedAt: 1, targetLanguageCode: 'en', sourceLanguageCode: 'zh-Hant', meetingId: 'meeting-1', segmentId: 'segment-1' });
  return { sessions, meetings };
}

function finalCue(overrides = {}) {
  return { cueId: 'cue:session-1:segment-1:1', sessionId: 'session-1', segmentId: 'segment-1', sequence: 1, startTimeMs: 0, endTimeMs: 100, sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', sourceText: '你好', translatedText: 'hello', status: 'final', finalizedReason: 'final', ...overrides };
}
