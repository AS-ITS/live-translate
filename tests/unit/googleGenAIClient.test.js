import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDefaultGoogleGenAIClient,
  createGoogleGenAIClient
} from '../../src/infrastructure/googleGenAIClient.js';

test('valid API key constructs one SDK client with exact constructor options', () => {
  const calls = [];
  class FakeGoogleGenAI {
    constructor(options) {
      calls.push(options);
      this.options = options;
    }
  }

  const client = createGoogleGenAIClient({
    apiKey: 'test-api-key',
    GoogleGenAI: FakeGoogleGenAI
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { apiKey: 'test-api-key' });
  assert.equal(Object.keys(calls[0]).length, 1);
  assert.equal(client instanceof FakeGoogleGenAI, true);
  assert.strictEqual(client.options, calls[0]);
});

test('returned value is the exact constructed SDK instance', () => {
  let constructedClient;
  class FakeGoogleGenAI {
    constructor(options) {
      this.options = options;
      constructedClient = this;
    }
  }

  const client = createGoogleGenAIClient({
    apiKey: 'test-api-key',
    GoogleGenAI: FakeGoogleGenAI
  });

  assert.strictEqual(client, constructedClient);
});

test('missing configuration and invalid API keys fail clearly', () => {
  class FakeGoogleGenAI {}

  assert.throws(() => createGoogleGenAIClient(), /configuration object is required/);
  assert.throws(() => createGoogleGenAIClient({ GoogleGenAI: FakeGoogleGenAI }), /apiKey must be a non-empty string/);
  assert.throws(
    () => createGoogleGenAIClient({ apiKey: '', GoogleGenAI: FakeGoogleGenAI }),
    /apiKey must be a non-empty string/
  );
  assert.throws(
    () => createGoogleGenAIClient({ apiKey: '   ', GoogleGenAI: FakeGoogleGenAI }),
    /apiKey must be a non-empty string/
  );
});

test('missing or invalid constructor dependency fails before construction', () => {
  let callCount = 0;
  class FakeGoogleGenAI {
    constructor() {
      callCount += 1;
    }
  }

  assert.throws(() => createGoogleGenAIClient({ apiKey: 'test-api-key', GoogleGenAI: undefined }), /GoogleGenAI/);
  assert.throws(() => createGoogleGenAIClient({ apiKey: 'test-api-key', GoogleGenAI: {} }), /GoogleGenAI/);
  assert.throws(() => createGoogleGenAIClient({ apiKey: 'test-api-key', GoogleGenAI: () => ({}) }), /GoogleGenAI/);
  assert.equal(callCount, 0);

  createGoogleGenAIClient({ apiKey: 'test-api-key', GoogleGenAI: FakeGoogleGenAI });
  assert.equal(callCount, 1);
});

test('production wrapper loads the official SDK constructor without making a request', () => {
  const client = createDefaultGoogleGenAIClient({ apiKey: 'test-api-key' });

  assert.equal(typeof client, 'object');
  assert.equal(typeof client.models, 'object');
});

test('separate invocations construct separate instances with no extra constructor calls', () => {
  const calls = [];
  class FakeGoogleGenAI {
    constructor(options) {
      calls.push(options);
    }
  }

  const first = createGoogleGenAIClient({ apiKey: 'first-key', GoogleGenAI: FakeGoogleGenAI });
  const second = createGoogleGenAIClient({ apiKey: 'second-key', GoogleGenAI: FakeGoogleGenAI });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [{ apiKey: 'first-key' }, { apiKey: 'second-key' }]);
  assert.notStrictEqual(first, second);
});
