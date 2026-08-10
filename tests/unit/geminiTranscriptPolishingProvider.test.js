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

test('polishing request requires addressable source and translation results', () => {
  const request = buildTranscriptPolishingRequest({ input, model: 'gemini-3.5-flash-lite' });
  assert.equal(request.model, 'gemini-3.5-flash-lite');
  assert.equal(Object.hasOwn(request, 'generationConfig'), false);
  assert.match(request.contents[0].parts[0].text, /Do not add facts/);
  assert.match(request.contents[0].parts[0].text, /polishedText/);
  assert.match(request.contents[0].parts[0].text, /Polish the existing translation only/);
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

test('provider normalizes source and translation corrections from JSON', async () => {
  const provider = createGeminiTranscriptPolishingProvider({
    client: { generateContent() { return { text: JSON.stringify({ polishedItems: [
      { cueId: 'cue-1', sequence: 1, polishedText: 'Long meeting.' }
    ] }) }; } }
  });

  assert.deepEqual(await provider.execute({ ...input, polishingItems: [
    { cueId: 'cue-1', sequence: 1, sourceText: '常會議', translationText: 'Long meeting.' }
  ] }), {
    translatedText: 'Long meeting.',
    polishedItems: [{ cueId: 'cue-1', sequence: 1, polishedText: 'Long meeting.' }],
    detectedSourceLanguageCode: undefined
  });
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
