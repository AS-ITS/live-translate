import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchMeetingViewerSnapshotWithRetry } from '../../src/lib/meetingViewerSnapshot.js';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test('Viewer snapshot retries transient 503 without discarding the current detail', async () => {
  const current = { meeting: { id: 'meeting-1' }, cues: [{ cueId: 'cue-1', sourceText: '保留字幕' }] };
  const statuses = [
    response(503, { error: { code: 'cloud_capability_unavailable' } }),
    response(200, { meeting: { id: 'meeting-1' }, cues: [{ cueId: 'cue-2', sourceText: '恢復字幕' }] }),
  ];
  const waits = [];
  const value = await fetchMeetingViewerSnapshotWithRetry({
    url: '/api/shared-meetings/token',
    fetchImpl: async () => statuses.shift(),
    wait: async (delay) => { waits.push(delay); },
    random: () => 0.5,
  });
  assert.equal(current.cues[0].sourceText, '保留字幕');
  assert.equal(value.cues[0].sourceText, '恢復字幕');
  assert.deepEqual(waits, [1_000]);
});

test('Viewer snapshot does not retry revoked, stopped, or unauthorized shares', async () => {
  for (const [status, code] of [[403, 'share_unauthorized'], [404, 'share_unauthorized'], [410, 'meeting_stopped']]) {
    let attempts = 0;
    await assert.rejects(() => fetchMeetingViewerSnapshotWithRetry({
      url: '/api/shared-meetings/token',
      fetchImpl: async () => { attempts += 1; return response(status, { error: { code } }); },
      wait: async () => { throw new Error('terminal errors must not wait'); },
    }), (error) => error.code === code);
    assert.equal(attempts, 1);
  }
});

test('Viewer snapshot reports retry exhaustion after six bounded attempts', async () => {
  let attempts = 0;
  const waits = [];
  await assert.rejects(() => fetchMeetingViewerSnapshotWithRetry({
    url: '/api/shared-meetings/token',
    fetchImpl: async () => { attempts += 1; return response(503, { error: { code: 'viewer_unavailable' } }); },
    wait: async (delay) => { waits.push(delay); },
    random: () => 0.5,
  }), (error) => error.code === 'viewer_retry_exhausted');
  assert.equal(attempts, 6);
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 10_000]);
});
