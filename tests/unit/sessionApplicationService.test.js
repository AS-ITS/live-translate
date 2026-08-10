import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionApplicationService } from '../../src/application/sessionApplicationService.js';

test('session application service delegates session commands and read models', async () => {
  const calls = [];
  const sessionRepository = {
    createSessionRecord(input) { calls.push(['create', input]); return { id: 'session-1' }; },
    updateSessionRecord(id, patch) { calls.push(['update', id, patch]); return { id, ...patch }; },
    finalizeSessionRecord(id, patch) { calls.push(['finalize', id, patch]); return { id, ...patch }; }
  };
  const sessionReadRepository = {
    listSessionHistory() { calls.push(['list']); return [{ id: 'session-1' }]; },
    getSessionDetail(id) { calls.push(['detail', id]); return { session: { id } }; }
  };
  const service = createSessionApplicationService({ sessionRepository, sessionReadRepository });

  assert.deepEqual(await service.createSession({ id: 'session-1' }), { id: 'session-1' });
  assert.deepEqual(await service.updateSession('session-1', { name: 'Demo' }), { id: 'session-1', name: 'Demo' });
  assert.deepEqual(await service.stopSession('session-1', { endedAt: 1000 }), { id: 'session-1', status: 'stopped', endedAt: 1000 });
  assert.deepEqual(await service.completeSession('session-1'), { id: 'session-1', status: 'completed' });
  assert.deepEqual(await service.failSession('session-1', { failureReason: 'network' }), { id: 'session-1', status: 'failed', failureReason: 'network' });
  assert.deepEqual(await service.listSessions(), [{ id: 'session-1' }]);
  assert.deepEqual(await service.getSessionDetail('session-1'), { session: { id: 'session-1' } });

  assert.deepEqual(calls, [
    ['create', { id: 'session-1' }],
    ['update', 'session-1', { name: 'Demo' }],
    ['finalize', 'session-1', { status: 'stopped', endedAt: 1000 }],
    ['finalize', 'session-1', { status: 'completed' }],
    ['finalize', 'session-1', { status: 'failed', failureReason: 'network' }],
    ['list'],
    ['detail', 'session-1']
  ]);
});

test('session application service validates both repository boundaries', () => {
  assert.throws(
    () => createSessionApplicationService({ sessionReadRepository: {} }),
    /sessionRepository.createSessionRecord is required/
  );
  assert.throws(
    () => createSessionApplicationService({
      sessionRepository: { createSessionRecord() {}, updateSessionRecord() {}, finalizeSessionRecord() {} },
      sessionReadRepository: {}
    }),
    /sessionReadRepository.listSessionHistory is required/
  );
});
