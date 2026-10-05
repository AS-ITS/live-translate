import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoverySingleFlight } from '../../src/lib/recoverySingleFlight.js';

test('same segment shares one in-flight recovery promise', async () => {
  const coordinator = createRecoverySingleFlight();
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });

  const first = coordinator.run('meeting-1:segment-1', async () => {
    calls += 1;
    await pending;
    return { segment: 'segment-2' };
  });
  const second = coordinator.run('meeting-1:segment-1', async () => {
    calls += 1;
    return { segment: 'unexpected' };
  });

  assert.strictEqual(first, second);
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    { segment: 'segment-2' },
    { segment: 'segment-2' }
  ]);
  assert.equal(calls, 1);
});

test('settled recovery is reused until the segment key is cleared', async () => {
  const coordinator = createRecoverySingleFlight();
  let calls = 0;

  const first = await coordinator.run('meeting-1:segment-1', () => ({ calls: ++calls }));
  const duplicate = await coordinator.run('meeting-1:segment-1', () => ({ calls: ++calls }));

  assert.deepEqual(duplicate, first);
  assert.equal(calls, 1);

  coordinator.clear('meeting-1:segment-1');
  assert.deepEqual(await coordinator.run('meeting-1:segment-2', () => ({ calls: ++calls })), { calls: 2 });
  assert.deepEqual(await coordinator.run('meeting-1:segment-1', () => ({ calls: ++calls })), { calls: 3 });
});

test('rejected recovery is shared without starting a second request', async () => {
  const coordinator = createRecoverySingleFlight();
  let calls = 0;
  const failure = new Error('recover failed');
  const operation = () => {
    calls += 1;
    throw failure;
  };

  await assert.rejects(coordinator.run('meeting-1:segment-1', operation), failure);
  await assert.rejects(coordinator.run('meeting-1:segment-1', operation), failure);
  assert.equal(calls, 1);
});

