import test from 'node:test';
import assert from 'node:assert/strict';
import { createCueTranslationLifecycle } from '../../src/lib/cueTranslationLifecycle.js';

test('submits one idempotent Flash translation execution per Cue', async () => {
  const requests = [];
  const executions = [];
  const lifecycle = createCueTranslationLifecycle({
    apiClient: {
      async createTranslationRequest(input) { requests.push(input); return input; },
      async createTranslationExecution(input) { executions.push(input); return input; }
    },
    now: () => '2026-09-04T00:00:00.000Z'
  });
  const cue = { cueId: 'cue-1', segmentId: 'segment-1', sequence: 1, sourceText: '你好', status: 'final' };

  const first = await lifecycle.submitCue({ sessionId: 'session-1', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', cue });
  const second = await lifecycle.submitCue({ sessionId: 'session-1', sourceLanguageCode: 'zh-Hant', targetLanguageCode: 'en', cue });

  assert.equal(first.cueId, 'cue-1');
  assert.equal(second, null);
  assert.equal(requests.length, 1);
  assert.equal(executions.length, 1);
  assert.equal(requests[0].operation, 'cue_translation');
  assert.equal(requests[0].model, 'gemini-3.5-flash');
  assert.equal(requests[0].sourceTranscriptSnapshot.cueId, 'cue-1');
  assert.equal(executions[0].translationRequestId, requests[0].id);
});

test('failed submission can be retried', async () => {
  let attempts = 0;
  const lifecycle = createCueTranslationLifecycle({
    apiClient: {
      async createTranslationRequest() { attempts += 1; if (attempts === 1) throw new Error('temporary'); },
      async createTranslationExecution(input) { return input; }
    }
  });
  const cue = { cueId: 'cue-2', sequence: 1, sourceText: '測試', status: 'final' };

  await assert.rejects(lifecycle.submitCue({ sessionId: 'session-1', targetLanguageCode: 'en', cue }), /temporary/);
  const result = await lifecycle.submitCue({ sessionId: 'session-1', targetLanguageCode: 'en', cue });
  assert.equal(result.cueId, 'cue-2');
  assert.equal(attempts, 2);
});
