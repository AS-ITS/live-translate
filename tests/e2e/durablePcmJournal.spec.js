import { expect, test } from '@playwright/test';

test('Chromium Pause and Continue retain one owner per PCM epoch after reload', async ({ page }) => {
  const recordingId = `pauseintegrity${Date.now()}`;
  const meetingId = `meeting-${recordingId}`;
  const pauseId = `pause:${recordingId}:segment-1`;
  const continueId = `continue-${recordingId}`;
  await page.goto('/');
  const paused = await page.evaluate(async ({ meetingId, recordingId, pauseId, continueId }) => {
    const { createLocalMeetingPersistence } = await import('/src/lib/localMeetingPersistence.js');
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const { createDurablePcmJournalClient } = await import('/src/lib/durablePcmJournalClient.js');
    const store = createIndexedDbLocalMeetingManifestStore();
    const local = createLocalMeetingPersistence({ manifestStore: store });
    await local.startLifecycle({ meetingId, recordingId, segmentId: 'segment-1',
      operationId: 'start-1', pcmEnabled: true });
    const journal = createDurablePcmJournalClient({ meetingId, recordingId });
    await journal.open();
    journal.offer(new Uint8Array(3200).fill(11), { connectionEpoch: 1 });
    await journal.flush({ endEpoch: true, transitionOperationId: pauseId });
    const receipt = await journal.verifiedTransitionReceipt(pauseId);
    await local.pauseLifecycle({ operationId: pauseId, boundaryReceipt: receipt });
    return { receipt, recording: await store.getRecording(meetingId),
      segments: await store.listSegments(meetingId),
      continueOperation: await store.getSegmentTransition(meetingId, continueId) };
  }, { meetingId, recordingId, pauseId, continueId });
  expect(paused.receipt.transitionOperationId).toBe(pauseId);
  expect(paused.receipt).toMatchObject({ recordingId, captureEpoch: 1, endSample: 1600 });
  expect(paused.receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(paused.recording.pauseBoundary).toEqual(paused.receipt);
  expect(paused.segments.map(({ segmentId, status }) => [segmentId, status]))
    .toEqual([['segment-1', 'ACTIVE']]);
  expect(paused.continueOperation).toBeNull();

  await page.reload();
  const continued = await page.evaluate(async ({ meetingId, recordingId, pauseId, continueId }) => {
    const { createLocalMeetingPersistence } = await import('/src/lib/localMeetingPersistence.js');
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const { createDurablePcmJournalClient } = await import('/src/lib/durablePcmJournalClient.js');
    const store = createIndexedDbLocalMeetingManifestStore();
    const receiptJournal = createDurablePcmJournalClient({ meetingId, recordingId,
      existingOnly: true, readOnly: true });
    await receiptJournal.open();
    const receipt = await receiptJournal.verifiedTransitionReceipt(pauseId);
    await receiptJournal.close();
    const local = createLocalMeetingPersistence({ manifestStore: store });
    await local.startLifecycle({ meetingId, recordingId, segmentId: 'segment-1',
      operationId: 'start-1', pcmEnabled: true });
    const ownershipBeforeContinue = await local.verifySegmentPcmOwnership(meetingId);
    if (ownershipBeforeContinue.status !== 'ACTIVE_UNSEALED') {
      throw new Error(`Pre-Continue ownership: ${JSON.stringify(ownershipBeforeContinue)}`);
    }
    await local.continueLifecycle({ operationId: continueId, nextSegmentId: 'segment-2' });
    const journal = createDurablePcmJournalClient({ meetingId, recordingId });
    await journal.open();
    journal.offer(new Uint8Array(3200).fill(22), { connectionEpoch: 2 });
    await journal.flush({ endEpoch: true });
    await local.endLifecycle({ operationId: 'end-1' });
    return { receipt, transition: await store.getSegmentTransition(meetingId, continueId) };
  }, { meetingId, recordingId, pauseId, continueId });
  expect(continued.receipt).toEqual(paused.receipt);
  expect(continued.transition.boundaryOperationId).toBe(pauseId);
  expect(continued.transition.boundary).toEqual(paused.receipt);

  await page.reload();
  const restored = await page.evaluate(async ({ meetingId, recordingId, pauseId, continueId }) => {
    const { createLocalMeetingPersistence } = await import('/src/lib/localMeetingPersistence.js');
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const { createDurablePcmJournalClient } = await import('/src/lib/durablePcmJournalClient.js');
    const store = createIndexedDbLocalMeetingManifestStore();
    const journal = createDurablePcmJournalClient({ meetingId, recordingId,
      existingOnly: true, readOnly: true });
    let status;
    let receipt;
    let coverage;
    let pcm;
    try {
      status = await journal.open();
      receipt = await journal.verifiedTransitionReceipt(pauseId);
      coverage = await Promise.all([journal.coverage(1, 0, 1600), journal.coverage(2, 0, 1600)]);
      pcm = await Promise.all([journal.readRange(1, 0, 1600), journal.readRange(2, 0, 1600)]);
    } finally {
      await journal.close();
    }
    const local = createLocalMeetingPersistence({ manifestStore: store });
    return { status, receipt, coverage, pcmBytes: pcm.map((bytes) => [bytes.length, bytes[0]]),
      recording: await store.getRecording(meetingId), segments: await store.listSegments(meetingId),
      transition: await store.getSegmentTransition(meetingId, continueId),
      ownership: await local.verifySegmentPcmOwnership(meetingId) };
  }, { meetingId, recordingId, pauseId, continueId });
  expect(restored.status.tailState).toBe('CLEAN');
  expect(restored.receipt).toEqual(paused.receipt);
  expect(restored.coverage.map(({ complete, gaps, epochClosed }) =>
    ({ complete, gaps, epochClosed }))).toEqual([
    { complete: true, gaps: [], epochClosed: true },
    { complete: true, gaps: [], epochClosed: true }
  ]);
  expect(restored.pcmBytes).toEqual([[3200, 11], [3200, 22]]);
  expect(restored.recording.segmentId).toBe('segment-2');
  expect(restored.segments.map(({ segmentId, status, firstJournalEpoch, lastJournalEpoch }) =>
    [segmentId, status, firstJournalEpoch, lastJournalEpoch])).toEqual([
    ['segment-1', 'ENDED', 1, 1], ['segment-2', 'ENDED', 2, null]
  ]);
  expect(restored.transition.phase).toBe('COMMITTED');
  expect(restored.transition.boundary).toEqual(paused.receipt);
  expect(restored.ownership.status, JSON.stringify(restored.ownership)).toBe('PASS');
});

test('Chromium Reload restores the OPFS END receipt and atomic IndexedDB Segment ledger', async ({ page }) => {
  const id = `segmentintegrity${Date.now()}`;
  const meetingId = `meeting-${id}`;
  await page.goto('/');
  await page.evaluate(async ({ id, meetingId }) => {
    const { createDurablePcmJournalClient } = await import('/src/lib/durablePcmJournalClient.js');
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const store = createIndexedDbLocalMeetingManifestStore();
    const recording = { meetingId, recordingId: id, segmentId: 'segment-1', segmentNumber: 1,
      captureEpoch: 1, providerEpoch: 0, state: 'capturing', integrityVersion: 2, pcmEnabled: true };
    await store.commitRecordingOperation({ recording, operation: { meetingId, operationId: 'start-1',
      type: 'start', result: recording } });
    const transition = { meetingId, recordingId: id, operationId: 'rollover-1',
      predecessorId: 'segment-1', predecessorSequence: 1,
      successorId: 'segment-2', successorSequence: 2 };
    await store.prepareSegmentTransition(transition);
    const client = createDurablePcmJournalClient({ meetingId, recordingId: id });
    await client.open();
    client.offer(new Uint8Array(3200).fill(1), { connectionEpoch: 1 });
    client.offer(new Uint8Array(3200).fill(2), { connectionEpoch: 2 });
    await client.flush({ endEpoch: true, transitionOperationId: 'rollover-1' });
    const boundary = await client.verifiedTransitionReceipt('rollover-1');
    await store.commitSegmentTransition({ ...transition, boundary });
  }, { id, meetingId });
  await page.reload();
  const restored = await page.evaluate(async ({ id, meetingId }) => {
    const { createDurablePcmJournalClient } = await import('/src/lib/durablePcmJournalClient.js');
    const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
    const store = createIndexedDbLocalMeetingManifestStore();
    const client = createDurablePcmJournalClient({ meetingId, recordingId: id,
      existingOnly: true, readOnly: true });
    const journal = await client.open();
    const receipt = await client.verifiedTransitionReceipt('rollover-1');
    const epochOne = await client.coverage(1, 0, 1600);
    const epochTwo = await client.coverage(2, 0, 1600);
    return { journal, receipt, epochOne, epochTwo,
      recording: await store.getRecording(meetingId),
      segments: await store.listSegments(meetingId),
      transition: await store.getSegmentTransition(meetingId, 'rollover-1') };
  }, { id, meetingId });
  expect(restored.journal.tailState).toBe('CLEAN');
  expect(restored.receipt).toEqual(restored.transition.boundary);
  expect(restored.epochOne.complete).toBe(true);
  expect(restored.epochTwo.complete).toBe(true);
  expect(restored.recording.segmentId).toBe('segment-2');
  expect(restored.segments.map(({ status, firstJournalEpoch, lastJournalEpoch }) =>
    [status, firstJournalEpoch, lastJournalEpoch])).toEqual([
    ['ENDED', 1, 2], ['ACTIVE', 3, null]
  ]);
  expect(restored.transition.phase).toBe('COMMITTED');
});

test('Chromium OPFS commits segmented PCM and restores it after reload', async ({ page }) => {
  const recordingId = `journal${Date.now()}`;
  await page.goto('/');
  const first = await page.evaluate(async (id) => {
    const { createDurablePcmJournalClient } = await import('/src/lib/durablePcmJournalClient.js');
    const { LiveTranslateSession } = await import('/src/lib/liveSession.js');
    const client = createDurablePcmJournalClient({ meetingId: `meeting-${id}`, recordingId: id });
    await client.open();
    let providerSends = 0;
    const session = new LiveTranslateSession({ targetLanguageCode: 'en',
      onInputAudioChunk: (pcm, metadata) => client.offer(pcm, metadata) });
    session.session = { sendRealtimeInput: () => { providerSends += 1; } };
    session.providerReady = true;
    session.inputSendingEnabled = true;
    for (let index = 0; index < 10; index += 1) {
      session.sendInputAudioChunk(new Uint8Array(3200).fill(index + 1), session.connectionEpoch,
        { force: true });
    }
    await client.flush({ endEpoch: true });
    return { ...client.status(), providerSends };
  }, recordingId);
  expect(first.pendingBytes).toBe(0);
  expect(first.providerSends).toBe(10);
  await page.reload();
  const second = await page.evaluate(async (id) => {
    const { createDurablePcmJournalClient } = await import('/src/lib/durablePcmJournalClient.js');
    const client = createDurablePcmJournalClient({ meetingId: `meeting-${id}`, recordingId: id });
    const status = await client.open();
    const coverage = await client.coverage(1, 0, 16_000);
    const pcm = await client.readRange(1, 0, 16_000);
    client.offer(new Uint8Array(3200).fill(21), { connectionEpoch: 2 });
    await client.flush({ endEpoch: true });
    const continued = await client.readRange(2, 0, 1600);
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle('pcm-journals');
    const version = await base.getDirectoryHandle('v1');
    const meeting = await version.getDirectoryHandle(`meeting-${id}`);
    const directory = await meeting.getDirectoryHandle(id);
    const files = [];
    for await (const [name] of directory.entries()) files.push(name);
    return { status, coverage: { complete: coverage.complete, gaps: coverage.gaps },
      pcmLength: pcm.length, firstByte: pcm[0], lastByte: pcm.at(-1),
      continuedByte: continued[0], files };
  }, recordingId);
  expect(second.status.committedBytes).toBe(32_000);
  expect(second.coverage).toEqual({ complete: true, gaps: [] });
  expect([second.pcmLength, second.firstByte, second.lastByte]).toEqual([32_000, 1, 10]);
  expect(second.continuedByte).toBe(21);
  expect(second.files.sort()).toEqual(['claims.bin', 'pcm-000001.bin']);
});

test('Chromium reload during uncommitted batch reports an unknown capture tail', async ({ page }) => {
  const recordingId = `interrupted${Date.now()}`;
  await page.goto('/');
  await page.evaluate(async (id) => {
    const { createDurablePcmJournalClient } = await import('/src/lib/durablePcmJournalClient.js');
    const client = createDurablePcmJournalClient({ meetingId: `meeting-${id}`, recordingId: id });
    await client.open();
    client.offer(new Uint8Array(3200).fill(7), { connectionEpoch: 1 });
  }, recordingId);
  await page.reload();
  const result = await page.evaluate(async (id) => {
    const { createDurablePcmJournalClient } = await import('/src/lib/durablePcmJournalClient.js');
    const client = createDurablePcmJournalClient({ meetingId: `meeting-${id}`, recordingId: id });
    const previous = await client.open();
    const coverage = await client.coverage(1, 0, 1600);
    return { previous, coverage: { complete: coverage.complete, gaps: coverage.gaps } };
  }, recordingId);
  expect(result.previous.highestEpoch).toBe(1);
  expect(result.previous.openEpochs).toEqual([1]);
  expect(result.coverage).toEqual({ complete: false, gaps: [[0, 1600]] });
});

test('Chromium partial claim tail preserves verified prefix and rejects new writes', async ({ page }) => {
  const recordingId = `partial${Date.now()}`;
  await page.goto('/');
  await page.evaluate(async (id) => {
    const { createDurablePcmJournalClient } = await import('/src/lib/durablePcmJournalClient.js');
    const client = createDurablePcmJournalClient({ meetingId: `meeting-${id}`, recordingId: id });
    await client.open();
    for (let index = 0; index < 10; index += 1) {
      client.offer(new Uint8Array(3200).fill(31), { connectionEpoch: 1 });
    }
    await client.flush({ endEpoch: true });
  }, recordingId);
  await page.reload();
  const result = await page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle('pcm-journals');
    const version = await base.getDirectoryHandle('v1');
    const meeting = await version.getDirectoryHandle(`meeting-${id}`);
    const directory = await meeting.getDirectoryHandle(id);
    const ledger = await directory.getFileHandle('claims.bin');
    const size = (await ledger.getFile()).size;
    const writer = await ledger.createWritable({ keepExistingData: true });
    await writer.seek(size);
    await writer.write(new Uint8Array([1, 2, 3]));
    await writer.close();
    const { createDurablePcmJournalClient } = await import('/src/lib/durablePcmJournalClient.js');
    const client = createDurablePcmJournalClient({ meetingId: `meeting-${id}`, recordingId: id });
    const status = await client.open();
    const coverage = await client.coverage(1, 0, 16_000);
    const pcm = await client.readRange(1, 0, 16_000);
    const refused = client.offer(new Uint8Array(3200), { connectionEpoch: 2 });
    return { tailState: status.tailState, complete: coverage.complete,
      pcmLength: pcm.length, firstByte: pcm[0], refused };
  }, recordingId);
  expect(result.tailState).toBe('CORRUPT_OR_INCOMPLETE_LEDGER');
  expect([result.complete, result.pcmLength, result.firstByte]).toEqual([true, 32_000, 31]);
  expect(result.refused.state).toBe('REJECTED');
});
