import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactTranslationHistoryForDetail,
  mergeRetranslationHistoryIntoDetail,
  removeRetranslationOutputFromDetail,
  retryLineagesForExecutions
} from '../../src/lib/sessionTranslationHistory.js';

test('compacts missing and malformed translation history into stable arrays', () => {
  assert.deepEqual(compactTranslationHistoryForDetail(null), { outputs: [], executions: [] });
  assert.deepEqual(compactTranslationHistoryForDetail({ translationHistory: { outputs: 'invalid', executions: [{ id: 'execution-1' }] } }), {
    outputs: [],
    executions: [{ id: 'execution-1' }]
  });
});

test('groups retry executions by request ID and sorts each lineage chronologically', () => {
  const lineages = retryLineagesForExecutions([
    { id: 'retry-1', requestId: 'request-1', createdAt: '2026-08-10T02:00:00.000Z' },
    { id: 'request-2-execution', requestId: 'request-2', createdAt: '2026-08-10T01:00:00.000Z' },
    { id: 'original-1', translationRequestId: 'request-1', createdAt: '2026-08-10T01:00:00.000Z' },
    { id: 'legacy-execution', createdAt: '2026-08-10T03:00:00.000Z' }
  ]);

  assert.deepEqual(lineages.map(({ requestId, executions }) => [requestId, executions.map(({ id }) => id)]), [
    ['request-1', ['original-1', 'retry-1']],
    ['request-2', ['request-2-execution']],
    [null, ['legacy-execution']]
  ]);
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

test('does not replace detail without authoritative history and removes outputs immutably', () => {
  const detail = {
    id: 'session-1',
    translationHistory: {
      outputs: [{ id: 'output-1', translatedText: 'one' }, { id: 'output-2', translatedText: 'two' }],
      executions: [{ id: 'execution-1' }]
    }
  };

  assert.strictEqual(mergeRetranslationHistoryIntoDetail(detail, null), detail);
  const result = removeRetranslationOutputFromDetail(detail, 'output-1');

  assert.deepEqual(result.translationHistory, { outputs: [{ id: 'output-2', translatedText: 'two' }], executions: [{ id: 'execution-1' }] });
  assert.equal(result.polishedArticle.status, 'empty');
  assert.deepEqual(detail.translationHistory.outputs, [{ id: 'output-1', translatedText: 'one' }, { id: 'output-2', translatedText: 'two' }]);
});
