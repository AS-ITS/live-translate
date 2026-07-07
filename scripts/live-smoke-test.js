import { GoogleGenAI, Modality } from '@google/genai';
import { isSupportedLanguage } from '../server/languages.js';
import { createLiveToken, LIVE_TRANSLATE_MODEL } from '../server/tokenService.js';

const ENABLED = process.env.ENABLE_REAL_GEMINI_TEST === 'true';
const TARGET_LANGUAGE = process.env.LIVE_SMOKE_TARGET_LANGUAGE || 'zh-Hant';
const TIMEOUT_MS = Number.parseInt(process.env.LIVE_SMOKE_TIMEOUT_MS || '15000', 10);

if (!ENABLED) {
  console.log('Skipping live smoke test. Set ENABLE_REAL_GEMINI_TEST=true to call the real Gemini Live API.');
  process.exit(0);
}

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is required when ENABLE_REAL_GEMINI_TEST=true.');
  process.exit(1);
}

if (!isSupportedLanguage(TARGET_LANGUAGE)) {
  console.error(`Unsupported LIVE_SMOKE_TARGET_LANGUAGE: ${TARGET_LANGUAGE}`);
  process.exit(1);
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function main() {
  const tokenResponse = await createLiveToken({
    targetLanguageCode: TARGET_LANGUAGE,
    echoTargetLanguage: true
  });

  const ai = new GoogleGenAI({
    apiKey: tokenResponse.token,
    httpOptions: {
      apiVersion: 'v1alpha'
    }
  });

  const session = await withTimeout(
    ai.live.connect({
      model: LIVE_TRANSLATE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        generationConfig: {
          translationConfig: {
            targetLanguageCode: TARGET_LANGUAGE,
            echoTargetLanguage: true
          }
        }
      },
      callbacks: {
        onmessage() {},
        onerror(event) {
          throw new Error(event?.message || event?.error?.message || 'Gemini Live API error');
        },
        onclose() {}
      }
    }),
    TIMEOUT_MS
  );

  session.close();
  console.log(`Live smoke test connected and closed a Gemini Live session for ${TARGET_LANGUAGE}.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
