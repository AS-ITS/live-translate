import { expect, test } from '@playwright/test';

test('Host reload rebuilds a scoped Viewer snapshot from IndexedDB Cues', async ({ page }) => {
  const meetingId = `host-snapshot-${Date.now()}`;
  await page.goto('/');
  await page.evaluate(async (id) => {
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const store = createIndexedDbLocalMeetingManifestStore();
    const save = (meetingId, segmentId, cueId, sequence, translatedText) => store.saveCue({
      meetingId, sessionId: 'session-1', segmentId,
      cue: { cueId, sessionId: 'session-1', segmentId, sequence, status: 'final',
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
