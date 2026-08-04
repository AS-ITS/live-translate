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

test('checkpoint saves and reloads recovery-only cue state', async () => {
  const { sessions, meetings } = await fixture();
  const repository = createSubtitleCueRepository({ sessionRepository: sessions, meetingRepository: meetings });
  const checkpoint = { currentCue: { cueId: 'partial', status: 'partial' }, pendingCues: [], nextSequence: 2, finalizedCueKeys: ['key-1'], processedEventIds: ['event-1'], pendingBoundary: { turnComplete: false, generationComplete: true }, lastCommittedCueSequence: 1, lastCommittedEndTimeMs: 100 };
  await repository.saveCueCheckpoint('session-1', checkpoint);
  assert.deepEqual(await repository.loadCueCheckpoint('session-1'), checkpoint);
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
