import { expect, test } from '@playwright/test';
import { installHostViewerHarness } from './hostViewerHarness.js';
import { compareViewerCueState, readViewerCueStore } from './issue41ViewerFinalStateContract.js';

test('Pause flush converges a two-Cue Host with a one-Cue Viewer', async ({ page }) => {
  const meetingId = 'meeting-pause-flush';
  const first = { cueId: 'cue-1', meetingId, sessionId: 'session-1', segmentId: 'segment-1',
    sequence: 1, revision: 2, sourceText: 'source one', translatedText: 'translation one',
    sourceVersion: 2, translationVersion: 1, status: 'final' };
  const second = { cueId: 'cue-2', meetingId, sessionId: 'session-1', segmentId: 'segment-1',
    sequence: 2, revision: 1, sourceText: 'source two', translatedText: 'translation two',
    sourceVersion: 1, translationVersion: 1, status: 'final' };
  await installHostViewerHarness(page, {
    code: 'PAUSEFLUSH', meetingId, meetingName: 'Pause flush', cues: [first],
    segments: [{ id: 'segment-1', sessionId: 'session-1', sequence: 1, status: 'active' }]
  });
  await page.goto('/#viewer?code=PAUSEFLUSH');
  await expect.poll(async () => (await page.evaluate(readViewerCueStore)).cues?.length).toBe(1);
  const before = await page.evaluate(readViewerCueStore);
  expect(before.hostCursor.sequence).toBe(1);
  const records = [first, second].map((cue) => ({ meetingId, cueId: cue.cueId,
    sessionId: cue.sessionId, segmentId: cue.segmentId, sequence: cue.sequence, cue }));
  await page.evaluate(async ({ id, committed }) => {
    const { publishCommittedLocalCues } = await import('/src/webrtc/useWebRtcDeviceSidecar.js');
    publishCommittedLocalCues(id, committed, (cue) => {
      if (cue.cueId === 'cue-2') window.__hostPublish(cue);
    });
  }, { id: meetingId, committed: records });
  await expect.poll(async () => {
    const viewer = await page.evaluate(readViewerCueStore);
    return compareViewerCueState([first, second], viewer.cues || []).verdict;
  }).toBe('PASS');
  const after = await page.evaluate(readViewerCueStore);
  expect(after.hostCursor.sequence).toBe(2);
});

test('Host reload rebuilds a scoped Viewer snapshot from IndexedDB Cues', async ({ page }) => {
  const meetingId = `host-snapshot-${Date.now()}`;
  await page.goto('/');
  await page.evaluate(async (id) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const store = createIndexedDbLocalMeetingManifestStore();
    const save = (meetingId, segmentId, cueId, sequence, translatedText) => store.commitCueMutation({
      meetingId, segmentId, eventKey: `${meetingId}:${cueId}`, side: 'initial',
      cue: { cueId, sessionId: 'session-1', segmentId, sequence, status: 'final',
        startTimeMs: sequence * 100, endTimeMs: sequence * 100 + 50,
        sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', finalizedReason: 'final',
        sourceText: cueId, translatedText, sourceVersion: 1, translationVersion: 1 }
    });
    await save(id, 'segment-1', 'cue-1', 1, 'first translation');
    await save(id, 'segment-2', 'cue-2', 1, 'second translation');
    await save(`${id}-other`, 'segment-1', 'other', 1, 'must stay local to other meeting');
  }, meetingId);
  await page.reload();
  const result = await page.evaluate(async (id) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const { hostViewerCuesFromLocalRecords } = await import('/src/webrtc/useWebRtcDeviceSidecar.js');
    const { createSubtitleSource } = await import('/src/webrtc/subtitleDataChannel.js');
    const records = await createIndexedDbLocalMeetingManifestStore().listCues(id);
    const source = createSubtitleSource({ meetingId: id });
    hostViewerCuesFromLocalRecords(id, records).forEach((cue) => source.append(cue));
    const snapshot = source.snapshot();
    return { meetingId: snapshot.meetingId, cues: snapshot.cues.map(({ cueId, segmentId, sourceText,
      translatedText }) => ({ cueId, segmentId, sourceText, translatedText })) };
  }, meetingId);
  expect(result).toEqual({ meetingId, cues: [
    { cueId: 'cue-1', segmentId: 'segment-1', sourceText: 'cue-1', translatedText: 'first translation' },
    { cueId: 'cue-2', segmentId: 'segment-2', sourceText: 'cue-2', translatedText: 'second translation' }
  ] });
});

test('local-only Viewer receives Host snapshot, updates and reconnect replay without cloud Cues', async ({ page }) => {
  const state = await installHostViewerHarness(page, {
    code: 'LOCALONLY', meetingId: 'meeting-local', segments: [],
    lifecycle: { lifecycleContractVersion: 2, recordingState: 'waiting', cloudStatus: 'created' },
    cues: [{ cueId: 'cue-1', segmentId: 'local-segment-1', sessionId: 'local-session-1',
      sequence: 1, sourceText: 'Host snapshot', sourceVersion: 1 }],
  });
  await page.goto('/#viewer?code=LOCALONLY');
  await expect(page.getByText('Host snapshot')).toBeVisible();
  await page.evaluate(() => window.__hostPublish({ cueId: 'cue-1', meetingId: 'meeting-local',
    segmentId: 'local-segment-1', sessionId: 'local-session-1', sequence: 1,
    sourceText: 'Host update', sourceVersion: 2 }, 'cue.update'));
  await expect(page.getByText('Host update')).toBeVisible();
  await page.evaluate(() => {
    window.__hostClose();
    window.__hostPublish({ cueId: 'cue-2', meetingId: 'meeting-local',
      segmentId: 'local-segment-2', sessionId: 'local-session-2', segmentSequence: 2,
      sequence: 1, sourceText: 'Host replay', sourceVersion: 1 });
  });
  await expect(page.getByText('Host replay')).toBeVisible();
  await page.evaluate(() => window.__hostReceive({
    protocol: 'subtitle-webrtc/v1', type: 'recording.stopped', meetingId: 'meeting-local'
  }));
  await expect(page.getByText('錄音已停止，等待下一次錄製。')).toBeVisible();
  await page.evaluate(() => window.__hostReceive({
    protocol: 'subtitle-webrtc/v1', type: 'meeting.stopped', meetingId: 'meeting-local'
  }));
  await expect(page.getByText('會議已停止。')).toBeVisible();
  expect(state.cloudContentReads).toBe(0);
});
