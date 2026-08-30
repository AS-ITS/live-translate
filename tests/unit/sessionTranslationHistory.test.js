import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactTranslationHistoryForDetail,
  mergeRetranslationHistoryIntoDetail
} from '../../src/lib/sessionTranslationHistory.js';

test('compacts missing and malformed translation history into stable arrays', () => {
  assert.deepEqual(compactTranslationHistoryForDetail(null), { outputs: [], executions: [] });
  assert.deepEqual(compactTranslationHistoryForDetail({ translationHistory: { outputs: 'invalid', executions: [{ id: 'execution-1' }] } }), {
    outputs: [],
    executions: [{ id: 'execution-1' }]
  });
});

test('merges authoritative history while formal data replaces the same legacy output', () => {
  const detail = {
    id: 'session-1',
    translationHistory: {
      outputs: [
        { id: 'live-output:1', translatedText: 'legacy' },
        { id: 'output-1', translatedText: 'stale', version: null }
      ],
      executions: [{ id: 'old-execution' }]
    }
  };
  const translations = {
    translationHistory: {
      outputs: [{ id: 'output-1', translatedText: 'formal', version: 2, completedAt: '2026-08-10T01:00:00Z' }],
      executions: [{ id: 'new-execution', status: 'completed' }]
    }
  };

  const result = mergeRetranslationHistoryIntoDetail(detail, translations);

  assert.deepEqual(result.translationHistory.outputs, [
    { id: 'live-output:1', translatedText: 'legacy' },
    { id: 'output-1', translatedText: 'formal', version: 2, completedAt: '2026-08-10T01:00:00Z' }
  ]);
  assert.deepEqual(result.translationHistory.executions, [{ id: 'new-execution', status: 'completed' }]);
  assert.equal(result.polishedArticle.status, 'empty');
  assert.deepEqual(detail.translationHistory.outputs[1], { id: 'output-1', translatedText: 'stale', version: null });
});

test('projects polished outputs into a readable article and preserves the latest metadata', () => {
  const result = mergeRetranslationHistoryIntoDetail({ id: 'session-1' }, {
    translationHistory: {
      outputs: [
        { id: 'polish-1', operation: 'transcript_polishing', version: 1, createdAt: '2026-08-09', polishedItems: [{ cueId: 'cue-1', sequence: 1, polishedText: 'First' }] },
        { id: 'polish-2', operation: 'transcript_polishing', version: 2, createdAt: '2026-08-10', completedAt: '2026-08-10T01:00:00Z', polishedItems: [{ cueId: 'cue-2', sequence: 2, polishedText: 'Second' }] }
      ],
      executions: []
    }
  });

  assert.deepEqual(result.polishedArticle, {
    kind: 'polishedArticle',
    status: 'available',
    text: 'First\nSecond',
    paragraphs: ['First', 'Second'],
    items: [
      { cueId: 'cue-1', sequence: 1, polishedText: 'First' },
      { cueId: 'cue-2', sequence: 2, polishedText: 'Second' }
    ],
    version: 2,
    createdAt: '2026-08-10',
    completedAt: '2026-08-10T01:00:00Z',
    emptyReason: null
  });
});

test('does not replace detail without authoritative history', () => {
  const detail = {
    id: 'session-1',
    translationHistory: {
      outputs: [{ id: 'output-1', translatedText: 'one' }, { id: 'output-2', translatedText: 'two' }],
      executions: [{ id: 'execution-1' }]
    }
  };

  assert.strictEqual(mergeRetranslationHistoryIntoDetail(detail, null), detail);
  assert.deepEqual(detail.translationHistory.outputs, [{ id: 'output-1', translatedText: 'one' }, { id: 'output-2', translatedText: 'two' }]);
});
