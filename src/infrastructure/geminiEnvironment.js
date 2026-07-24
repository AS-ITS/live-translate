export function createGeminiEnvironment({ env = process.env } = {}) {
  assertEnv(env);

  const apiKey = readRequiredApiKey(env);

  return Object.freeze({
    apiKey
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
