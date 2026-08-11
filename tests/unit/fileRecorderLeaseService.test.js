import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFileRecorderLeaseService } from '../../src/infrastructure/fileRecorderLeaseService.js';

test('recorder lease allows one active recorder and fences stale writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-lease-'));
  let now = 1000;
  const service = createFileRecorderLeaseService({ filePath: join(directory, 'leases.json'), fileSystem: await import('node:fs/promises'), clock: () => now, ttlMs: 100 });
  const first = await service.claim('session-1');
  await assert.rejects(() => service.claim('session-1'), (error) => error.code === 'recorder_already_active');
  now = 1050;
  const renewed = await service.heartbeat('session-1', first.leaseId, first.fenceToken);
  assert.ok(renewed.expiresAt > first.expiresAt);
  await assert.rejects(() => service.heartbeat('session-1', first.leaseId, first.fenceToken + 1), (error) => error.code === 'recorder_lease_invalid');
  assert.equal(await service.release('session-1', first.leaseId, first.fenceToken), true);
  assert.equal((await service.claim('session-1')).fenceToken, 2);
  now = 2000;
  assert.equal(await service.current('session-1'), null);
});

test('recorder leases are independent across sessions and survive service reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-lease-'));
  const fileSystem = await import('node:fs/promises');
  const filePath = join(directory, 'leases.json');
  const first = createFileRecorderLeaseService({ filePath, fileSystem, clock: () => 1000, ttlMs: 1000 });
  const leaseA = await first.claim('session-a');
  const leaseB = await first.claim('session-b');
  const reloaded = createFileRecorderLeaseService({ filePath, fileSystem, clock: () => 1000, ttlMs: 1000 });
  assert.equal((await reloaded.current('session-a')).leaseId, leaseA.leaseId);
  assert.equal((await reloaded.current('session-b')).leaseId, leaseB.leaseId);
});
