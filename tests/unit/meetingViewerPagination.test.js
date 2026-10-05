import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingReadQueryService } from '../../src/application/meetingReadQueryService.js';
import { decodeViewerCursor, encodeViewerCursor } from '../../src/lib/meetingViewerPagination.js';

test('viewer cursor round-trips and rejects malformed input', () => {
  const cursor = encodeViewerCursor({ segmentSequence: 4, sequence: 17, cueId: 'cue-17' });
  assert.deepEqual(decodeViewerCursor(cursor), { v: 1, segmentSequence: 4, sequence: 17, cueId: 'cue-17' });
  assert.throws(() => decodeViewerCursor('not-a-cursor'), { code: 'invalid_request', status: 400 });
});

test('viewer read model returns the latest 100 cues and a backward cursor', async () => {
  const cues = Array.from({ length: 105 }, (_, index) => ({
    cueId: `cue-${index + 1}`,
    sequence: index + 1,
    segmentId: 'segment-1',
    status: 'final',
    sourceText: `source-${index + 1}`,
    translatedText: `translation-${index + 1}`,
    startTimeMs: index,
    endTimeMs: index + 1
  }));
  const service = createMeetingReadQueryService({
    meetingRepository: {
      async listMeetings() { return []; },
      async getMeeting() { return { id: 'meeting-1', name: 'Meeting', status: 'completed' }; },
      async listMeetingSegments() { return [{ id: 'segment-1', sequence: 0, checkpoint: { finalCues: cues } }]; }
    }
  });

  const first = await service.getMeetingViewerPage('meeting-1');
  assert.equal(first.cues.length, 100);
  assert.equal(first.cues[0].cueId, 'cue-6');
  assert.equal(first.cues.at(-1).cueId, 'cue-105');
  assert.equal(first.pagination.hasMore, true);

  const older = await service.getMeetingViewerPage('meeting-1', { before: first.pagination.nextCursor });
  assert.equal(older.cues.length, 5);
  assert.equal(older.cues[0].cueId, 'cue-1');
  assert.equal(older.pagination.hasMore, false);
});
