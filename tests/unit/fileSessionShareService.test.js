import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createFileSessionShareService } from '../../src/infrastructure/fileSessionShareService.js';

test('file session share service resolves a token after service reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-share-service-'));
  const filePath = join(directory, 'shares.json');
  const fs = await import('node:fs/promises');

  const first = createFileSessionShareService({ filePath, fileSystem: fs, clock: () => 1000 });
  const created = await first.createShare('session-1', { expiresAt: 2000 });
  const second = createFileSessionShareService({ filePath, fileSystem: fs, clock: () => 1500 });

  assert.equal((await second.resolveShare(created.token)).id, created.id);
  assert.equal((await second.listShares('session-1')).length, 1);
  assert.equal((await second.revokeShare('session-1', created.id)), true);
  assert.equal(await second.resolveShare(created.token), null);
});

test('file session share service persists the short code with the token hash but never the plaintext token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-share-service-'));
  const filePath = join(directory, 'shares.json');
  const fs = await import('node:fs/promises');
  const service = createFileSessionShareService({ filePath, fileSystem: fs, clock: () => 1000 });

  const created = await service.createShare('session-1');
  const stored = JSON.parse(await readFile(filePath, 'utf8'));

  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.shares.length, 1);
  assert.equal(stored.shares[0].tokenHash.length, 64);
  assert.equal(stored.shares[0].shortCode, created.shortCode);
  assert.equal(stored.shares[0].shortCodeHash.length, 64);
  assert.equal(JSON.stringify(stored).includes(created.token), false);
});

test('file session share service exposes a persisted Meeting short code only through the management list', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-share-service-meeting-'));
  const filePath = join(directory, 'shares.json');
  const fs = await import('node:fs/promises');
  const first = createFileSessionShareService({ filePath, fileSystem: fs, clock: () => 1000 });
  const created = await first.createMeetingShare('meeting-1', { role: 'viewer' });
  const second = createFileSessionShareService({ filePath, fileSystem: fs, clock: () => 1000 });

  const listed = await second.listMeetingShares('meeting-1');
  assert.equal(listed[0].shortCode, created.shortCode);
  assert.equal((await second.resolveCode(created.shortCode)).shortCode, undefined);
});

test('file session share service ensures one Meeting share per role across repeated calls and reloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-share-service-ensure-'));
  const filePath = join(directory, 'shares.json');
  const fs = await import('node:fs/promises');
  const first = createFileSessionShareService({ filePath, fileSystem: fs, clock: () => 1000 });
  const created = await first.ensureMeetingShare('meeting-1', { role: 'recorder' });
  const reused = await first.ensureMeetingShare('meeting-1', { role: 'recorder' });
  const second = createFileSessionShareService({ filePath, fileSystem: fs, clock: () => 1000 });
  const reloaded = await second.ensureMeetingShare('meeting-1', { role: 'recorder' });

  assert.equal(created.id, reused.id);
  assert.equal(created.id, reloaded.id);
  assert.equal(reused.token, undefined);
  assert.equal((await second.listMeetingShares('meeting-1')).length, 1);
});

test('file session share service serializes concurrent mutations without losing shares', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-share-service-'));
  const filePath = join(directory, 'shares.json');
  const fs = await import('node:fs/promises');
  const service = createFileSessionShareService({ filePath, fileSystem: fs, clock: () => 1000 });

  await Promise.all([
    service.createShare('session-1'),
    service.createShare('session-1'),
    service.createShare('session-1')
  ]);

  assert.equal((await service.listShares('session-1')).length, 3);
});

test('file session share service revokes all draft Meeting shares', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-share-service-meeting-'));
  const filePath = join(directory, 'shares.json');
  const fs = await import('node:fs/promises');
  const service = createFileSessionShareService({ filePath, fileSystem: fs, clock: () => 1000 });

  await service.createMeetingShare('meeting-1', { role: 'recorder' });
  await service.createMeetingShare('meeting-2', { role: 'recorder' });
  assert.equal(await service.revokeMeetingShares('meeting-1'), 1);
  assert.equal((await service.listShares('meeting-1')).length, 0);
  assert.equal((await service.listShares('meeting-2')).length, 1);
});

test('file session share service rejects invalid storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-translate-share-service-'));
  const filePath = join(directory, 'shares.json');
  const fs = await import('node:fs/promises');
  await fs.writeFile(filePath, JSON.stringify({ shares: [] }), 'utf8');

  const service = createFileSessionShareService({ filePath, fileSystem: fs });
  await assert.rejects(service.listShares('session-1'), (error) => error.code === 'invalid_session_share_storage');
});
