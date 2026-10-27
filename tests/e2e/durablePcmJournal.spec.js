import { expect, test } from '@playwright/test';

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
