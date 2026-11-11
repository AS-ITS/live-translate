import test from 'node:test';
import assert from 'node:assert/strict';
import { createCueMutationCoordinator } from '../../src/lib/cueMutationCoordinator.js';
import { createPreCoordinatorCueRetry } from '../../src/lib/preCoordinatorCueRetry.js';
import { completeMeetingAfterRecordingFinalize } from '../../src/features/live/useLiveRecordingController.js';

const change = (cueId, sequence) => ({ before: null, cue: {
  cueId, sessionId: 'recording-1', segmentId: 'segment-1', sequence,
  status: 'final', sourceText: `source-${sequence}`
} });

function harness() {
  const retry = createPreCoordinatorCueRetry();
  const saved = new Map();
  const commits = new Map();
  const viewer = [];
  let checkpoint = 0;
  let failSetup = true;
  let queue = Promise.resolve();
  const coordinator = createCueMutationCoordinator({
    createEventKey: () => 'event-1',
    commit: async ({ cue }) => {
      commits.set(cue.cueId, (commits.get(cue.cueId) || 0) + 1);
      if (!saved.has(cue.cueId)) saved.set(cue.cueId, cue);
      checkpoint = Math.max(checkpoint, cue.sequence);
      return { status: 'committed', cue: { ...cue, revision: 1 } };
    },
    onAck: ({ cue }) => { if (!viewer.includes(cue.cueId)) viewer.push(cue.cueId); }
  });
  function enqueue(cueId, sequence) {
    let registered = false;
    const task = async () => {
      if (cueId === 'A' && failSetup) throw Object.assign(new Error('private message'), { name: 'AbortError' });
      const job = coordinator.enqueue({ meetingId: 'meeting-1', segmentId: 'segment-1',
        changes: [change(cueId, sequence)] });
      registered = true;
      await job;
    };
    queue = queue.catch(() => {}).then(() => retry.run(task, () => registered));
    return queue;
  }
  async function flush() {
    const work = queue.catch(() => {}).then(async () => {
      await retry.drain();
      const failures = await coordinator.flush();
      if (failures.length) throw new Error('Cue writer failed');
    });
    queue = work;
    return work;
  }
  return { enqueue, flush, saved, commits, viewer, retry,
    get checkpoint() { return checkpoint; },
    recoverSetup() { failSetup = false; }
  };
}

test('pre-coordinator failure is invisible to the original swallowed queue and coordinator flush', async () => {
  const coordinator = createCueMutationCoordinator({
    createEventKey: () => 'event-1', commit: async ({ cue }) => ({ status: 'committed', cue })
  });
  let queue = Promise.reject(new Error('setup failed before enqueue'));
  queue = queue.catch(() => {}).then(() => coordinator.enqueue({
    meetingId: 'meeting-1', segmentId: 'segment-1', changes: [change('B', 2)]
  }));
  await queue;
  assert.deepEqual(await coordinator.flush(), []);
});

test('a later Cue waits for failed setup to recover before advancing checkpoint or Viewer', async () => {
  const state = harness();
  await assert.rejects(state.enqueue('A', 1), /private message/);
  assert.equal(state.retry.pendingCount, 1);
  assert.equal(state.checkpoint, 0);
  assert.deepEqual(state.viewer, []);
  const second = state.enqueue('B', 2);
  await assert.rejects(second, /private message/);
  assert.equal(state.retry.pendingCount, 2);
  assert.equal(state.checkpoint, 0);
  await assert.rejects(state.flush(), /private message/);
  state.recoverSetup();
  await state.flush();
  assert.deepEqual([...state.saved.keys()], ['A', 'B']);
  assert.deepEqual([...state.commits.values()], [1, 1]);
  assert.equal(state.checkpoint, 2);
  assert.deepEqual(state.viewer, ['A', 'B']);
  assert.deepEqual([...new Map(state.saved).keys()], ['A', 'B']); // Reload readback.
  assert.equal(state.retry.pendingCount, 0);
});

test('failed setup blocks Pause and End; retry commits each Cue once', async () => {
  const state = harness();
  await assert.rejects(state.enqueue('A', 1));
  await assert.rejects(state.enqueue('B', 2));
  let pauseCommitted = false;
  let endCompleted = false;
  const pause = async () => { await state.flush(); pauseCommitted = true; };
  const end = () => completeMeetingAfterRecordingFinalize({
    flushCuePublishes: state.flush,
    completeMeeting: () => { endCompleted = true; }
  });
  await assert.rejects(pause());
  await assert.rejects(end());
  assert.equal(pauseCommitted, false);
  assert.equal(endCompleted, false);
  assert.equal(state.retry.pendingCount, 2);
  state.recoverSetup();
  await pause();
  await end();
  assert.equal(pauseCommitted, true);
  assert.equal(endCompleted, true);
  assert.deepEqual([...state.saved.keys()], ['A', 'B']);
  assert.deepEqual([...state.commits.values()], [1, 1]);
});
