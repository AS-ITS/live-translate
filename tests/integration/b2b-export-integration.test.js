import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeCuesById } from '../../src/lib/cueMerge.js';
import { exportCuesToTxt } from '../../src/lib/subtitleCueExport.js';

describe('B2B Export Path Integration', () => {
  const mockCues = (cues) => cues.map(c => ({
    ...c,
    status: 'final',
    sequence: c.sequence || 1,
    startTimeMs: c.startTimeMs || 0,
    endTimeMs: c.endTimeMs || 1000,
  }));

  it('should include unassigned cues in the export source', () => {
    const cloudCues = [];
    const unassignedCues = mockCues([{ cueId: 'cue-1', sourceText: 'Unassigned', translatedText: 'Unassigned' }]);

    const merged = mergeCuesById(cloudCues, unassignedCues);
    const output = exportCuesToTxt(merged, { stream: 'translation' });

    assert.ok(output.includes('Unassigned'), 'Export should contain unassigned cue text');
  });

  it('should export equivalent identities once', () => {
    const cloudCues = mockCues([{ cueId: 'cue-1', sourceText: 'Hello', translatedText: '你好', revision: 1, sequence: 1 }]);
    const unassignedCues = mockCues([{ cueId: 'cue-1', sourceText: 'Hello', translatedText: '你好', revision: 1, sequence: 1 }]);

    const merged = mergeCuesById(cloudCues, unassignedCues);
    const output = exportCuesToTxt(merged, { stream: 'translation' });

    const occurrences = (output.match(/你好/g) || []).length;
    assert.strictEqual(occurrences, 1, 'Equivalent cues should be merged into one');
  });

  it('blocks conflicting content for the same identity', () => {
    const cloudCues = mockCues([{ cueId: 'cue-1', sourceText: 'Hello', translatedText: '你好', revision: 1, sequence: 1 }]);
    const unassignedCues = mockCues([{ cueId: 'cue-1', sourceText: 'Hello', translatedText: '你好-fixed', revision: 2, sequence: 1 }]);

    assert.throws(() => mergeCuesById(cloudCues, unassignedCues), { code: 'subtitle_cue_conflict' });
  });

  it('should keep same text with distinct identities separate', () => {
    const cloudCues = mockCues([{ cueId: 'cue-1', sourceText: 'Hello', translatedText: '你好', sequence: 1 }]);
    const unassignedCues = mockCues([{ cueId: 'cue-2', sourceText: 'Hello', translatedText: '你好', sequence: 2, startTimeMs: 1000, endTimeMs: 2000 }]);

    const merged = mergeCuesById(cloudCues, unassignedCues);
    const output = exportCuesToTxt(merged, { stream: 'translation' });

    const occurrences = (output.match(/你好/g) || []).length;
    assert.strictEqual(occurrences, 2, 'Distinct identities with same text should both be exported');
  });

  it('should allow cues with null segment ownership', () => {
    const cues = mockCues([{ cueId: 'cue-1', segmentId: null, sourceText: 'Hello', translatedText: '你好', sequence: 1 }]);

    const merged = mergeCuesById([], cues);
    const output = exportCuesToTxt(merged, { stream: 'translation' });

    assert.ok(output.includes('你好'), 'Cues with null segmentId should still be exported');
  });
});
