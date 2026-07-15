import { GoogleGenAI as DefaultGoogleGenAI } from '@google/genai';

export function createGoogleGenAIClient({ apiKey, GoogleGenAI } = {}) {
  assertConfig(arguments.length > 0);
  assertApiKey(apiKey);
  assertGoogleGenAI(GoogleGenAI);

  return new GoogleGenAI({ apiKey });
}

export function createDefaultGoogleGenAIClient({ apiKey } = {}) {
  assertConfig(arguments.length > 0);

  return createGoogleGenAIClient({
    apiKey,
    GoogleGenAI: DefaultGoogleGenAI
  });
}

function assertConfig(hasConfig) {
  if (!hasConfig) {
    throw new TypeError('configuration object is required.');
  }
}

function assertApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new TypeError('apiKey must be a non-empty string.');
  }
}

function assertGoogleGenAI(GoogleGenAI) {
  if (typeof GoogleGenAI !== 'function' || !isConstructable(GoogleGenAI)) {
    throw new TypeError('GoogleGenAI must be a constructable function.');
  }
}

function isConstructable(value) {
  try {
    Reflect.construct(Object, [], value);
    return true;
  } catch {
    return false;
  }
}
