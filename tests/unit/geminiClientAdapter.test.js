import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeminiClientAdapter } from '../../src/infrastructure/geminiClientAdapter.js';

test('factory returns a frozen adapter with the generateContent contract', () => {
  const adapter = createGeminiClientAdapter({ client: client() });

  assert.equal(Object.isFrozen(adapter), true);
  assert.deepEqual(Object.keys(adapter), ['generateContent']);
  assert.equal(typeof adapter.generateContent, 'function');
  assert.equal(adapter.generateContent.length, 1);
  assert.throws(() => {
    adapter.configure = () => {};
  }, TypeError);
});

test('invalid construction dependencies fail fast', () => {
  assert.throws(() => createGeminiClientAdapter(), /client is required/);
  assert.throws(() => createGeminiClientAdapter({ client: null }), /client is required/);
  assert.throws(() => createGeminiClientAdapter({ client: [] }), /client is required/);
  assert.throws(() => createGeminiClientAdapter({ client: {} }), /client\.models is required/);
  assert.throws(
    () => createGeminiClientAdapter({ client: { models: {} } }),
    /client\.models\.generateContent must be a function/
  );
});

test('delegates exactly once and forwards the original request object', () => {
  const calls = [];
  const sdkResponse = { text: 'Bonjour' };
  const request = { model: 'gemini-test', contents: [{ parts: [{ text: 'Hello' }] }] };
  const before = structuredClone(request);
  const adapter = createGeminiClientAdapter({
    client: client({
      generateContent(input) {
        calls.push(input);
        return sdkResponse;
      }
    })
  });

  const response = adapter.generateContent(request);

  assert.equal(calls.length, 1);
  assert.strictEqual(calls[0], request);
  assert.deepEqual(request, before);
  assert.strictEqual(response, sdkResponse);
});

test('preserves Promise behavior and response identity', async () => {
  const sdkResponse = { text: 'Bonjour' };
  const sdkPromise = Promise.resolve(sdkResponse);
  const adapter = createGeminiClientAdapter({
    client: client({ response: sdkPromise })
  });

  const resultPromise = adapter.generateContent({ model: 'gemini-test' });

  assert.strictEqual(resultPromise, sdkPromise);
  assert.strictEqual(await resultPromise, sdkResponse);
});

test('propagates rejected SDK errors unchanged and does not retry', async () => {
  const originalError = new Error('provider rejected');
  const calls = [];
  const adapter = createGeminiClientAdapter({
    client: client({
      generateContent(request) {
        calls.push(request);
        return Promise.reject(originalError);
      }
    })
  });

  await assert.rejects(adapter.generateContent({ model: 'gemini-test' }), (error) => error === originalError);
  assert.equal(calls.length, 1);
});

test('propagates synchronous SDK throws unchanged and does not retry', () => {
  const originalError = new Error('provider threw');
  let callCount = 0;
  const adapter = createGeminiClientAdapter({
    client: client({
      generateContent() {
        callCount += 1;
        throw originalError;
      }
    })
  });

  assert.throws(() => adapter.generateContent({ model: 'gemini-test' }), (error) => error === originalError);
  assert.equal(callCount, 1);
});

function client({ response = { text: 'Bonjour' }, generateContent } = {}) {
  return {
    models: {
      generateContent: generateContent ?? (() => response)
    }
  };
}
