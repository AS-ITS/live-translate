import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpfsChunkStore } from '../../src/lib/localMeetingStorage.js';

function missing() { return Object.assign(new Error('not found'), { name: 'NotFoundError' }); }
function directory(children = {}) {
  return {
    children,
    async getDirectoryHandle(name) {
      if (!this.children[name]) throw missing();
      return this.children[name];
    },
    async removeEntry(name) {
      if (!this.children[name]) throw missing();
      if (this.failOnce) { this.failOnce = false; throw new Error('journal deletion failed'); }
      delete this.children[name];
    }
  };
}

test('meeting deletion removes Journal after chunks and retries Journal failure', async () => {
  const meetings = directory({ 'meeting-a': directory() });
  const journals = directory({ 'meeting-a': directory({ 'recording-a': directory() }),
    'meeting-b': directory({ 'recording-b': directory() }) });
  journals.failOnce = true;
  const root = directory({ meetings, 'pcm-journals': directory({ v1: journals }) });
  const store = createOpfsChunkStore({ rootDirectory: root });
  await assert.rejects(store.removeMeeting('meeting-a'), /journal deletion failed/);
  assert.equal(meetings.children['meeting-a'], undefined);
  assert.ok(journals.children['meeting-a']);
  await store.removeMeeting('meeting-a');
  await store.removeMeeting('meeting-a');
  assert.equal(journals.children['meeting-a'], undefined);
  assert.ok(journals.children['meeting-b']);
});
