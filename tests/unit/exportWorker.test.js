import assert from 'node:assert/strict';
import test from 'node:test';
import { createExportWorker } from '../../src/application/exportWorker.js';

test('export worker acknowledges successful jobs and retries failed jobs independently', async () => {
  const calls = [];
  const worker = createExportWorker({
    exportArtifactService: { async process(message) { calls.push(message); if (message.artifactId === 'bad') throw Object.assign(new Error('failed'), { code: 'export_failed' }); } },
    queue: {
      async claim() { return [{ messageId: '1', readCt: 1, message: { ownerUserId: 'u1', artifactId: 'good', meetingId: 'm1' } }, { messageId: '2', readCt: 2, message: { ownerUserId: 'u1', artifactId: 'bad', meetingId: 'm1' } }]; },
      async acknowledge(input) { calls.push(['ack', input]); },
      async retry(input) { calls.push(['retry', input]); }
    }
  });

  assert.deepEqual(await worker.runOnce({ limit: 2 }), { processed: 1, failed: 1 });
  assert.deepEqual(calls, [
    { ownerUserId: 'u1', artifactId: 'good', meetingId: 'm1' },
    ['ack', { messageId: '1', readCt: 1 }],
    { ownerUserId: 'u1', artifactId: 'bad', meetingId: 'm1' },
    ['retry', { messageId: '2', readCt: 2, attempt: 2, errorCode: 'export_failed', message: { ownerUserId: 'u1', artifactId: 'bad', meetingId: 'm1' } }]
  ]);
});
