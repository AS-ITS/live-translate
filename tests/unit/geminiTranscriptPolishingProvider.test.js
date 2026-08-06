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
  polishingItems: [{ sourceText: '你好', translationText: 'Hello', sequence: 1 }]
};

test('polishing request contains data-only instructions and structured response config', () => {
  const request = buildTranscriptPolishingRequest({ input, model: 'gemini-3.5-flash-lite' });
  assert.equal(request.model, 'gemini-3.5-flash-lite');
  assert.equal(request.generationConfig.responseMimeType, 'application/json');
  assert.match(request.contents[0].parts[0].text, /Do not add facts/);
  assert.match(request.contents[0].parts[0].text, /Hello/);
});

test('provider normalizes structured response and invokes client once', async () => {
  const calls = [];
  const provider = createGeminiTranscriptPolishingProvider({
    client: { generateContent(request) { calls.push(request); return { text: '{"polishedText":"Hello, everyone."}' }; } }
  });
  assert.deepEqual(await provider.execute(input), { translatedText: 'Hello, everyone.', detectedSourceLanguageCode: undefined });
  assert.equal(calls.length, 1);
});

test('invalid polishing response is rejected', () => {
  assert.throws(() => normalizeTranscriptPolishingResponse({ text: '{"text":"wrong"}' }), /polishedText/);
  assert.throws(() => normalizeTranscriptPolishingResponse({ text: 'not json' }), /valid JSON/);
});
