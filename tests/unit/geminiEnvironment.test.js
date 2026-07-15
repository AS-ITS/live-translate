import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_GEMINI_MODEL,
  createGeminiEnvironment
} from '../../src/infrastructure/geminiEnvironment.js';

test('valid environment returns trimmed apiKey and model', () => {
  const result = createGeminiEnvironment({
    env: {
      GEMINI_API_KEY: '  test-api-key  ',
      GEMINI_MODEL: '  gemini-custom  '
    }
  });

  assert.deepEqual(result, {
    apiKey: 'test-api-key',
    model: 'gemini-custom'
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

test('default model is applied when GEMINI_MODEL is omitted', () => {
  assert.deepEqual(createGeminiEnvironment({ env: { GEMINI_API_KEY: 'test-api-key' } }), {
    apiKey: 'test-api-key',
    model: DEFAULT_GEMINI_MODEL
  });
});

test('custom model is returned and trimmed', () => {
  assert.deepEqual(
    createGeminiEnvironment({
      env: {
        GEMINI_API_KEY: 'test-api-key',
        GEMINI_MODEL: '  gemini-2.5-flash  '
      }
    }),
    {
      apiKey: 'test-api-key',
      model: 'gemini-2.5-flash'
    }
  );
});

test('whitespace-only model throws deterministic error', () => {
  assert.throws(
    () =>
      createGeminiEnvironment({
        env: {
          GEMINI_API_KEY: 'test-api-key',
          GEMINI_MODEL: '   '
        }
      }),
    /^Error: Invalid GEMINI_MODEL$/
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
  const originalModel = process.env.GEMINI_MODEL;

  try {
    process.env.GEMINI_API_KEY = '  test-api-key  ';
    delete process.env.GEMINI_MODEL;

    createGeminiEnvironment();

    assert.equal(process.env.GEMINI_API_KEY, '  test-api-key  ');
    assert.equal(Object.hasOwn(process.env, 'GEMINI_MODEL'), false);
  } finally {
    restoreEnvValue('GEMINI_API_KEY', originalApiKey);
    restoreEnvValue('GEMINI_MODEL', originalModel);
  }
});

test('input env object is not mutated', () => {
  const env = {
    GEMINI_API_KEY: '  test-api-key  ',
    GEMINI_MODEL: '  gemini-custom  '
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
