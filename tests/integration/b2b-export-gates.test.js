import assert from 'node:assert/strict';
import test from 'node:test';
import { meetingExportSource } from '../../src/lib/meetingExportSource.js';

test('Gate 1: Distinct identities retain their Segment ownership', async () => {
  const assignedCue = {
    cueId: 'assigned-cue-id',
    segmentId: 'segment-1',
    status: 'final',
    sourceText: 'A',
    translatedText: 'A',
    startTimeMs: 1000,
    endTimeMs: 2000,
  };
  const unassignedCue = {
    cueId: 'unassigned-cue-id',
    segmentId: null,
    status: 'final',
    sourceText: 'B',
    translatedText: 'B',
    startTimeMs: 1000,
    endTimeMs: 2000,
  };

  const detail = {
    meeting: { id: 'meeting-123' },
    cues: [assignedCue, unassignedCue],
    transcriptItems: []
  };

  const source = meetingExportSource(detail);

  const hasSegmentNull = source.cues.some(c => c.segmentId === null);
  const hasSegmentNotNull = source.cues.some(c => c.segmentId !== null);

  assert.ok(hasSegmentNull, 'Unassigned cue should keep segmentId: null');
  assert.ok(hasSegmentNotNull, 'Assigned cue should keep its segmentId');
  assert.strictEqual(source.cues.length, 2);
});
