import assert from 'node:assert/strict';
import test from 'node:test';
import { meetingExportSource } from '../../src/lib/meetingExportSource.js';

test('meeting export source hash is deterministic across input order', () => {
  const first = meetingExportSource({
    meeting: { startedAt: 0 },
    transcriptItems: [
      { id: 'b', segmentSequence: 1, sequence: 2, stream: 'source', text: 'second', startedAt: 20 },
      { id: 'a', segmentSequence: 1, sequence: 1, stream: 'source', text: 'first', startedAt: 10 }
    ],
    cues: []
  });
  const second = meetingExportSource({
    meeting: { startedAt: 0 },
    transcriptItems: [
      { id: 'a', segmentSequence: 1, sequence: 1, stream: 'source', text: 'first', startedAt: 10 },
      { id: 'b', segmentSequence: 1, sequence: 2, stream: 'source', text: 'second', startedAt: 20 }
    ],
    cues: []
  });

  assert.equal(first.sourceHash, second.sourceHash);
  assert.deepEqual(first.items.map((item) => item.id), ['a', 'b']);
});
