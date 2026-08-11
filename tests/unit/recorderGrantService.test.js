import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecorderGrantService } from '../../src/application/recorderGrantService.js';

test('recorder grants retain only a hash and validate their Session lease binding', () => {
  let now = 1000;
  const service = createRecorderGrantService({ clock: () => now, ttlMs: 100 });
  const issued = service.issue({ sessionId: 'session-1', shareId: 'share-1', leaseId: 'lease-1', fenceToken: 1 });

  assert.equal(service.validate(issued.grant).sessionId, 'session-1');
  assert.equal(service.validate('not-a-grant'), null);
  assert.equal(Object.values(service).includes?.(issued.grant), false);
  now = 1100;
  assert.equal(service.validate(issued.grant), null);
});

test('refresh extends a valid grant and revoke invalidates it', () => {
  let now = 1000;
  const service = createRecorderGrantService({ clock: () => now, ttlMs: 100 });
  const issued = service.issue({ sessionId: 'session-1', shareId: 'share-1', leaseId: 'lease-1', fenceToken: 1 });
  now = 1050;
  assert.equal(service.refresh(issued.grant).expiresAt, 1150);
  assert.equal(service.revoke(issued.grant), true);
  assert.equal(service.validate(issued.grant), null);
});
