import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTranscriptPolishingRequest,
  createGeminiTranscriptPolishingProvider,
  normalizeTranscriptPolishingResponse
} from '../../src/infrastructure/geminiTranscriptPolishingProvider.js';

const input = {
  sessionId: 'session-1',
  targetLanguageCode: 'en',
  polishingItems: [{ cueId: 'cue-1', sourceText: '你好', translationText: 'Hello', sequence: 1 }]
};

test('polishing request requires one plain-text refined result without structured output config', () => {
  const request = buildTranscriptPolishingRequest({ input, model: 'gemini-3.5-flash-lite' });
  assert.equal(request.model, 'gemini-3.5-flash-lite');
  assert.equal(Object.hasOwn(request, 'generationConfig'), false);
  assert.match(request.contents[0].parts[0].text, /Do not add facts/);
  assert.match(request.contents[0].parts[0].text, /Output only the polished text/);
  assert.match(request.contents[0].parts[0].text, /Do not translate/);
  assert.match(request.contents[0].parts[0].text, /cue-1/);
  assert.match(request.contents[0].parts[0].text, /Hello/);
});

test('provider stores trimmed plain text as refinedText and invokes client once', async () => {
  const calls = [];
  const provider = createGeminiTranscriptPolishingProvider({
    client: { generateContent(request) { calls.push(request); return { text: '  Hello, everyone.  ' }; } }
  });
  assert.deepEqual(await provider.execute(input), {
    translatedText: 'Hello, everyone.',
    detectedSourceLanguageCode: undefined
  });
  assert.equal(calls.length, 1);
});

test('invalid polishing response is rejected', () => {
  assert.throws(() => normalizeTranscriptPolishingResponse({ text: '{"text":"wrong"}' }), /provider_invalid_response/);
  assert.throws(() => normalizeTranscriptPolishingResponse({ text: '["wrong"]' }), /provider_invalid_response/);
});

test('markdown code fences are safely converted to plain text', () => {
  assert.deepEqual(normalizeTranscriptPolishingResponse({ text: '```text\nHello, everyone.\n```' }), {
    refinedText: 'Hello, everyone.'
  });
});
