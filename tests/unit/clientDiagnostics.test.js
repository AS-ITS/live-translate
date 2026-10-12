import assert from 'node:assert/strict';
import test from 'node:test';
import { attachClientDiagnosticLifecycle, exportClientDiagnostics } from '../../src/lib/clientDiagnostics.js';
import { configureLivePipelineTrace, livePipelineTrace } from '../../src/lib/livePipelineTrace.js';

test.afterEach(() => configureLivePipelineTrace(false));

test('mobile export prefers file sharing and does not invoke lifecycle actions', async () => {
  configureLivePipelineTrace(true);
  livePipelineTrace.record({ stage: 'SESSION_STATE_CHANGED', role: 'recorder', meetingId: 'meeting-1' });
  let shared = null;
  let lifecycleCalls = 0;
  class MockFile {
    constructor(parts, name, options) { Object.assign(this, { parts, name, type: options.type }); }
  }

  const result = await exportClientDiagnostics({
    role: 'recorder',
    meetingId: 'meeting-1',
    FileImpl: MockFile,
    navigatorImpl: {
      canShare: ({ files }) => files.length === 1,
      share: async (value) => { shared = value; }
    }
  });

  assert.equal(result.method, 'share');
  assert.match(result.filename, /^live-translate-diagnostics-recorder-meeting-1-/u);
  assert.equal(shared.files[0].type, 'application/json;charset=utf-8');
  assert.equal(lifecycleCalls, 0);
});

test('mobile export falls back to JSON download and revokes the object URL', async () => {
  configureLivePipelineTrace(true);
  const actions = [];
  const anchor = {
    style: {},
    click: () => actions.push('click'),
    remove: () => actions.push('remove')
  };
  const result = await exportClientDiagnostics({
    role: 'viewer',
    meetingId: 'meeting/unsafe',
    FileImpl: class MockFile {},
    BlobImpl: class MockBlob {},
    navigatorImpl: { canShare: () => false },
    documentImpl: {
      body: { append: () => actions.push('append') },
      createElement: () => anchor
    },
    URLImpl: {
      createObjectURL: () => 'blob:diagnostics',
      revokeObjectURL: (url) => actions.push(`revoke:${url}`)
    },
    setTimer: (callback) => callback()
  });

  assert.equal(result.method, 'download');
  assert.match(result.filename, /viewer-meeting-unsafe-/u);
  assert.equal(anchor.download, result.filename);
  assert.deepEqual(actions, ['append', 'click', 'remove', 'revoke:blob:diagnostics']);
});

test('browser lifecycle logging records visibility, pageshow, and pagehide safely', () => {
  configureLivePipelineTrace(true);
  const documentListeners = new Map();
  const windowListeners = new Map();
  const documentImpl = {
    visibilityState: 'hidden',
    addEventListener: (name, handler) => documentListeners.set(name, handler),
    removeEventListener: (name) => documentListeners.delete(name)
  };
  const windowImpl = {
    addEventListener: (name, handler) => windowListeners.set(name, handler),
    removeEventListener: (name) => windowListeners.delete(name)
  };
  const detach = attachClientDiagnosticLifecycle({
    role: 'viewer',
    getContext: () => ({ meetingId: 'meeting-1', generation: 7 }),
    documentImpl,
    windowImpl
  });

  documentListeners.get('visibilitychange')();
  windowListeners.get('pageshow')({ persisted: true });
  windowListeners.get('pagehide')({ persisted: false });
  const entries = livePipelineTrace.get({ role: 'viewer' });
  assert.deepEqual(entries.map((entry) => entry.event), [
    'browser.visibilitychange',
    'browser.pageshow',
    'browser.pagehide'
  ]);
  assert.equal(entries[0].visibilityState, 'hidden');
  assert.equal(entries[1].pagePersisted, true);
  assert.equal(entries[0].generation, 7);
  detach();
  assert.equal(documentListeners.size, 0);
  assert.equal(windowListeners.size, 0);
});
