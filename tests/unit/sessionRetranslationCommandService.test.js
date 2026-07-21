import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionRetranslationCommandService } from '../../src/application/translation/sessionRetranslationCommandService.js';

test('submits canonical final source as a queued identifier-only command without provider execution', async () => {
  const calls = [];
  const sourceItems = [
    { stream: 'source', status: 'final', sequence: 2, text: 'world', languageCode: 'en' },
    { stream: 'source', status: 'final', sequence: 1, text: 'hello', languageCode: 'en' },
    { stream: 'source', status: 'partial', sequence: 3, text: 'ignored' }
  ];
  const detail = { sessionRecord: { id: 'session-1' }, transcriptItems: sourceItems };
  const service = createSessionRetranslationCommandService({
    sessionRepository: { getSessionRecord: () => detail },
    translationProviderResolver: { resolve: (key) => { calls.push(['resolve', key]); return { execute() { throw new Error('provider must not execute'); } }; } },
    translationCommandService: {
      createTranslationRequest: (input) => { calls.push(['request', input]); return { ...input }; },
      createTranslationExecution: (input) => {
        calls.push(['execution', input]);
        return { id: input.id, translationRequestId: input.translationRequestId, status: 'queued', providerKey: input.providerKey };
      }
    },
    idGenerator: (prefix) => prefix === 'translation-request' ? 'request-1' : 'execution-1',
    clock: () => 100
  });

  const input = { sessionId: 'session-1', targetLanguageCode: 'ja', providerKey: 'gemini' };
  const result = await service.submitRetranslation(input);

  assert.equal(Object.isFrozen(service), true);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(result, {
    request: { id: 'request-1', sessionId: 'session-1', sourceLanguageCode: 'en', targetLanguageCode: 'ja' },
    execution: { id: 'execution-1', requestId: 'request-1', status: 'queued', providerKey: 'gemini' }
  });
  assert.deepEqual(calls[1][1].sourceTranscriptSnapshot.items.map((item) => item.text), ['hello', 'world']);
  assert.equal(calls[1][1].sourceTranscriptSnapshot.sourceText, 'hello\nworld');
  assert.deepEqual(calls.map(([name]) => name), ['resolve', 'request', 'execution']);
  assert.deepEqual(input, { sessionId: 'session-1', targetLanguageCode: 'ja', providerKey: 'gemini' });
  assert.deepEqual(detail.transcriptItems, sourceItems);
});

test('validation, session, source, and provider resolution failures persist nothing', async () => {
  for (const scenario of [
    { name: 'missing session', detail: null, input: { sessionId: 'missing', targetLanguageCode: 'ja' } },
    { name: 'empty source', detail: { sessionRecord: { id: 'session-1' }, transcriptItems: [] }, input: { sessionId: 'session-1', targetLanguageCode: 'ja' } },
    { name: 'invalid target', detail: { sessionRecord: { id: 'session-1' }, transcriptItems: [] }, input: { sessionId: 'session-1', targetLanguageCode: 'xx' } },
    { name: 'unknown provider', detail: { sessionRecord: { id: 'session-1' }, transcriptItems: [{ stream: 'source', status: 'final', sequence: 0, text: 'source' }] }, input: { sessionId: 'session-1', targetLanguageCode: 'ja', providerKey: 'bad' }, resolveError: new Error('unknown provider') }
  ]) {
    const persisted = [];
    const service = createSessionRetranslationCommandService({
      sessionRepository: { getSessionRecord: () => scenario.detail },
      translationProviderResolver: { resolve: () => { if (scenario.resolveError) throw scenario.resolveError; } },
      translationCommandService: {
        createTranslationRequest: () => persisted.push('request'),
        createTranslationExecution: () => persisted.push('execution')
      }, idGenerator: () => 'id', clock: () => 0
    });
    await assert.rejects(service.submitRetranslation(scenario.input), scenario.resolveError || undefined, scenario.name);
    assert.deepEqual(persisted, [], scenario.name);
  }
});
