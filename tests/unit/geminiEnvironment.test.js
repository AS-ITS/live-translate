import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeminiEnvironment } from '../../src/infrastructure/geminiEnvironment.js';

test('valid environment returns trimmed apiKey', () => {
  const result = createGeminiEnvironment({
    env: {
      GEMINI_API_KEY: '  test-api-key  '
    }
  });

  assert.deepEqual(result, {
    apiKey: 'test-api-key'
  });
});

test('missing API key throws deterministic error', () => {
  assert.throws(() => createGeminiEnvironment({ env: {} }), /^Error: Missing GEMINI_API_KEY$/);
});

test('empty API key throws deterministic error', () => {
  assert.throws(() => createGeminiEnvironment({ env: { GEMINI_API_KEY: '' } }), /^Error: Missing GEMINI_API_KEY$/);
});

test('whitespace-only API key throws deterministic error', () => {
  assert.throws(
    () => createGeminiEnvironment({ env: { GEMINI_API_KEY: '   ' } }),
    /^Error: Missing GEMINI_API_KEY$/
  );
});

test('returned object is frozen', () => {
  const result = createGeminiEnvironment({ env: { GEMINI_API_KEY: 'test-api-key' } });

  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => {
    result.apiKey = 'changed';
  }, TypeError);
});

test('process.env is not mutated when default environment is used', () => {
  const originalApiKey = process.env.GEMINI_API_KEY;

  try {
    process.env.GEMINI_API_KEY = '  test-api-key  ';

    createGeminiEnvironment();

    assert.equal(process.env.GEMINI_API_KEY, '  test-api-key  ');
  } finally {
    restoreEnvValue('GEMINI_API_KEY', originalApiKey);
  }
});

test('input env object is not mutated', () => {
  const env = {
    GEMINI_API_KEY: '  test-api-key  '
  };
  const before = structuredClone(env);

  createGeminiEnvironment({ env });

  assert.deepEqual(env, before);
});

function restoreEnvValue(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
