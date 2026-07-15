export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro';

export function createGeminiEnvironment({ env = process.env } = {}) {
  assertEnv(env);

  const apiKey = readRequiredApiKey(env);
  const model = readModel(env);

  return Object.freeze({
    apiKey,
    model
  });
}

function assertEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('env must be an object.');
  }
}

function readRequiredApiKey(env) {
  const value = env.GEMINI_API_KEY;

  if (typeof value !== 'string') {
    throw new Error('Missing GEMINI_API_KEY');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('Missing GEMINI_API_KEY');
  }

  return trimmed;
}

function readModel(env) {
  const value = env.GEMINI_MODEL;

  if (value === undefined) {
    return DEFAULT_GEMINI_MODEL;
  }

  if (typeof value !== 'string') {
    throw new Error('Invalid GEMINI_MODEL');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('Invalid GEMINI_MODEL');
  }

  return trimmed;
}
