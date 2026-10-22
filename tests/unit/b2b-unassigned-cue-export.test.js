import assert from 'node:assert/strict';
import test from 'node:test';
import { createExportApplicationService } from '../../src/application/exportApplicationService.js';

test('exportTranscript should include final Cues with segmentId: null (Unassigned Cues)', () => {
  const service = createExportApplicationService();
  const items = [];
  const cues = [
    {
      cueId: 'cue-1',
      sessionId: 'session-1',
      meetingId: 'meeting-1',
      segmentId: null,
      sequence: 1,
      startTimeMs: 1000,
      endTimeMs: 2000,
      status: 'final',
      sourceText: 'Hello',
      translatedText: 'Bonjour',
      sourceLanguageCode: 'en',
      targetLanguageCode: 'fr'
    }
  ];

  // Test TXT export
  const txtOutput = service.exportTranscript({
    items,
    cues,
    options: { format: 'txt', stream: 'translation' }
  });

  assert.ok(txtOutput.includes('Bonjour'), 'TXT export should contain unassigned final Cue text');

  // Test SRT export
  const srtOutput = service.exportTranscript({
    items,
    cues,
    options: { format: 'srt', stream: 'translation' }
  });

  assert.ok(srtOutput.includes('Bonjour'), 'SRT export should contain unassigned final Cue text');
});