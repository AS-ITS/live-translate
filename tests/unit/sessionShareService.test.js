import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionShareService } from '../../src/application/sessionShareService.js';
import { createSessionEventBroadcaster } from '../../src/infrastructure/sessionEventBroadcaster.js';

test('share tokens resolve, hide token hash, and revoke', async () => {
  let now = 1000;
  const service = createSessionShareService({ clock: () => now });
  const created = service.createShare('session-1', { expiresAt: 2000 });

  assert.ok(created.token);
  assert.equal(created.sessionId, 'session-1');
  assert.equal(Object.hasOwn(created, 'tokenHash'), false);
  assert.equal((await service.resolveShare(created.token)).id, created.id);

  now = 2001;
  assert.equal(await service.resolveShare(created.token), null);
  assert.equal(service.revokeShare('session-1', created.id), true);
});

test('event broadcaster sequences snapshots per session and supports unsubscribe', () => {
  const broadcaster = createSessionEventBroadcaster();
  const events = [];
  const unsubscribe = broadcaster.subscribe('session-1', (event) => events.push(event));

  broadcaster.publish('session-1', { session: { id: 'session-1' } });
  broadcaster.publish('session-1', { session: { id: 'session-1', status: 'stopped' } });
  unsubscribe();
  broadcaster.publish('session-1', { session: { id: 'session-1', status: 'late' } });

  assert.deepEqual(events.map((event) => event.id), [1, 2]);
  assert.equal(broadcaster.snapshot('session-1').sequence, 3);
});

test('ensure Meeting share reuses the persisted short-code share without returning its token', () => {
  const service = createSessionShareService({ clock: () => 1000 });
  const first = service.ensureMeetingShare('meeting-1', { role: 'viewer' });
  const second = service.ensureMeetingShare('meeting-1', { role: 'viewer' });

  assert.equal(first.id, second.id);
  assert.equal(first.shortCode, second.shortCode);
  assert.ok(first.token);
  assert.equal(second.token, undefined);
  assert.equal(service.listMeetingShares('meeting-1').length, 1);
});
