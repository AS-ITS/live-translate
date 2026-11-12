import { expect, test } from '@playwright/test';

test('translated OPFS keeps sequential and parallel PCM across reload', async ({ page }) => {
  await page.goto('/');
  const rootProbe = await page.evaluate(async () => {
    try { await navigator.storage.getDirectory(); return { ok: true }; }
    catch (error) { return { ok: false, name: error.name }; }
  });
  if (!rootProbe.ok) {
    expect(rootProbe.name).toBe('UnknownError');
    test.skip(true, `OPFS root unavailable in this browser: ${rootProbe.name} at getDirectory`);
  }
  const meetingId = `rca-${crypto.randomUUID()}`;
  const paths = [1, 2, 3].map((sequence) =>
    `meetings/${meetingId}/translated-audio/s1/${String(sequence).padStart(8, '0')}.pcm`);
  await page.evaluate(async (entries) => {
    const { createOpfsChunkStore } = await import('/src/lib/localMeetingStorage.js');
    const store = createOpfsChunkStore();
    const write = async (path, bytes) => {
      try { await store.write(path, bytes); }
      catch (error) { throw new Error(`${error.name} ${error.opfsOperation || 'UNCLASSIFIED'} ${error.opfsApi || 'UNCLASSIFIED'}`); }
    };
    await write(entries[0], new Uint8Array([1, 0]));
    await Promise.all(entries.slice(1).map((path, index) =>
      write(path, new Uint8Array([index + 2, 0]))));
  }, paths);
  await page.reload();
  const recovered = await page.evaluate(async (entries) => {
    const { createOpfsChunkStore } = await import('/src/lib/localMeetingStorage.js');
    const store = createOpfsChunkStore();
    return Promise.all(entries.map(async (path) =>
      [...new Uint8Array(await (await store.read(path)).arrayBuffer())]));
  }, paths);
  expect(recovered).toEqual([[1, 0], [2, 0], [3, 0]]);
});
