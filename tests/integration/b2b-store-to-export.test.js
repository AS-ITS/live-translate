import assert from 'node:assert/strict';
import test from 'node:test';
import { meetingExportSource } from '../../src/lib/meetingExportSource.js';
import { createExportApplicationService } from '../../src/application/exportApplicationService.js';

test('B2B Store-to-Export Integration: Unassigned Cue should reach export when merged', async () => {
  const service = createExportApplicationService();

  const unassignedCue = {
    cueId: 'cue-unassigned-1',
    sessionId: 'session-1',
    meetingId: 'meeting-123',
    segmentId: null,
    sequence: 1,
    status: 'final',
    sourceText: 'Unassigned Hello',
    translatedText: 'Bonjour Non-Assigné',
    sourceVersion: 1,
    translationVersion: 0,
    startTimeMs: 1000,
    endTimeMs: 2000,
  };

  const detail = {
    meeting: { id: 'meeting-123', startedAt: Date.now() },
    cues: [unassignedCue],
    transcriptItems: []
  };

  const source = meetingExportSource(detail);

  assert.strictEqual(source.cues.length, 1);
  assert.strictEqual(source.cues[0].cueId, 'cue-unassigned-1');
  assert.strictEqual(source.cues[0].segmentId, null);

  const txtOutput = service.exportTranscript({
    items: source.items,
    cues: source.cues,
    options: { format: 'txt', stream: 'translation' }
  });

  assert.ok(txtOutput.includes('Bonjour Non-Assigné'), 'TXT export should contain unassigned cue text');
});

test('B2B Store-to-Export Integration: Assigned and Unassigned Cues together', async () => {
  const service = createExportApplicationService();

  const assignedCue = {
    cueId: 'cue-assigned-1',
    sessionId: 'session-1',
    meetingId: 'meeting-123',
    segmentId: 'segment-1',
    sequence: 1,
    status: 'final',
    sourceText: 'Assigned Hello',
    translatedText: 'Bonjour Assigné',
    startTimeMs: 1000,
    endTimeMs: 2000,
  };
  const unassignedCue = {
    cueId: 'cue-unassigned-1',
    sessionId: 'session-1',
    meetingId: 'meeting-123',
    segmentId: null,
    sequence: 10, // Different sequence to avoid conflict
    status: 'final',
    sourceText: 'Unassigned Hello',
    translatedText: 'Bonjour Non-Assigné',
    startTimeMs: 3000,
    endTimeMs: 4000,
  };

  const detail = {
    meeting: { id: 'meeting-123', startedAt: Date.now() },
    cues: [assignedCue, unassignedCue],
    transcriptItems: []
  };

  const source = meetingExportSource(detail);

  assert.strictEqual(source.cues.length, 2, 'Both cues should be included');

  const txtOutput = service.exportTranscript({
    items: source.items,
    cues: source.cues,
    options: { format: 'txt', stream: 'translation' }
  });

  assert.ok(txtOutput.includes('Bonjour Assigné'), 'Should contain assigned text');
  assert.ok(txtOutput.includes('Bonjour Non-Assigné'), 'Should contain unassigned text');
});

test('B2B Store-to-Export Integration: Only final Cues exported', async () => {
  const finalCue = {
    cueId: 'cue-final',
    status: 'final',
    sourceText: 'Final',
    translatedText: 'Finalisé',
    startTimeMs: 1000,
    endTimeMs: 2000,
  };
  const pendingCue = {
    cueId: 'cue-pending',
    status: 'pending',
    sourceText: 'Pending',
    translatedText: 'En attente',
    startTimeMs: 3000,
    endTimeMs: 4000,
  };

  const detail = {
    meeting: { id: 'meeting-123', startedAt: Date.now() },
    cues: [finalCue, pendingCue],
    transcriptItems: []
  };

  const source = meetingExportSource(detail);

  assert.strictEqual(source.cues.length, 1, 'Only final cues should be included');
  assert.strictEqual(source.cues[0].cueId, 'cue-final');
});
