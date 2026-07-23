import { isSupportedLanguage } from './languages.js';

export const LIVE_TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview';

export function normalizeTokenRequest(body = {}) {
  const targetLanguageCode = Object.hasOwn(body, 'targetLanguageCode') ? body.targetLanguageCode : 'en';
  const echoTargetLanguage =
    typeof body.echoTargetLanguage === 'boolean' ? body.echoTargetLanguage : true;

  if (!isSupportedLanguage(targetLanguageCode)) {
    const error = new Error('Unsupported targetLanguageCode');
    error.status = 400;
    throw error;
  }

  return { targetLanguageCode, echoTargetLanguage };
}

export function buildTokenConfig({ targetLanguageCode, echoTargetLanguage, glossaryEntries }, now = new Date()) {
  const expireTime = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(now.getTime() + 60 * 1000).toISOString();
  const translationConfig = {
    targetLanguageCode,
    echoTargetLanguage
  };
  const liveConnectConfig = {
    responseModalities: ['AUDIO'],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    generationConfig: {
      translationConfig
    },
    ...(Array.isArray(glossaryEntries) && glossaryEntries.length > 0
      ? { systemInstruction: glossaryInstruction(glossaryEntries) }
      : {})
  };

  return {
    uses: 1,
    expireTime,
    newSessionExpireTime,
    liveConnectConstraints: {
      model: LIVE_TRANSLATE_MODEL,
      config: liveConnectConfig
    },
    httpOptions: {
      apiVersion: 'v1alpha'
    }
  };
}

export async function createLiveToken(body, options = {}) {
  if (!process.env.GEMINI_API_KEY && !options.client) {
    const error = new Error('GEMINI_API_KEY is not configured');
    error.status = 500;
    throw error;
  }

  const request = normalizeTokenRequest(body);
  const now = options.now || new Date();
  const glossaryEntries = options.glossary === undefined
    ? undefined
    : await options.glossary.entriesFor(request.targetLanguageCode, { scope: 'live' });
  const configWithGlossary = buildTokenConfig({ ...request, ...(glossaryEntries === undefined ? {} : { glossaryEntries }) }, now);
  const client = options.client || (await createGenAiClient(process.env.GEMINI_API_KEY));

  try {
    const token = await client.authTokens.create({ config: configWithGlossary });
    return {
      token: token.name,
      expiresAt: configWithGlossary.expireTime,
      liveConnectConfig: configWithGlossary.liveConnectConstraints.config,
      liveGlossaryEntries: glossaryEntries || []
    };
  } catch (cause) {
    const error = new Error('Failed to create Gemini ephemeral token');
    error.status = 502;
    error.cause = cause;
    throw error;
  }
}

function glossaryInstruction(entries) {
  return {
    parts: [
      {
        text: [
          'Glossary instructions: when a source term occurs, use its specified target translation.',
          ...entries.map((entry) => `Source term: ${entry.source}\nRequired translation: ${entry.target}`)
        ].join('\n')
      }
    ]
  };
}

async function createGenAiClient(apiKey) {
  const { GoogleGenAI } = await import('@google/genai');
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: 'v1alpha'
    }
  });
}
