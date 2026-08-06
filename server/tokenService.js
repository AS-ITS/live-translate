import { isSupportedLanguage } from './languages.js';

export const DEFAULT_LIVE_TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview';
export const LIVE_TRANSLATE_MODEL = DEFAULT_LIVE_TRANSLATE_MODEL;
export const DEFAULT_SOURCE_LANGUAGE_CODE = 'zh-Hant';

export function normalizeTokenRequest(body = {}) {
  const targetLanguageCode = Object.hasOwn(body, 'targetLanguageCode') ? body.targetLanguageCode : 'en';
  const sourceLanguageCode = Object.hasOwn(body, 'sourceLanguageCode')
    ? body.sourceLanguageCode
    : DEFAULT_SOURCE_LANGUAGE_CODE;
  const echoTargetLanguage =
    typeof body.echoTargetLanguage === 'boolean' ? body.echoTargetLanguage : true;

  if (!isSupportedLanguage(targetLanguageCode)) {
    const error = new Error('Unsupported targetLanguageCode');
    error.status = 400;
    throw error;
  }

  if (!isSupportedLanguage(sourceLanguageCode)) {
    const error = new Error('Unsupported sourceLanguageCode');
    error.status = 400;
    throw error;
  }

  return { targetLanguageCode, sourceLanguageCode, echoTargetLanguage };
}

export function buildTokenConfig({
  targetLanguageCode,
  sourceLanguageCode = DEFAULT_SOURCE_LANGUAGE_CODE,
  echoTargetLanguage,
  glossaryEntries,
  liveTranslateModel = resolveLiveTranslateModel()
}, now = new Date()) {
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
    systemInstruction: buildSystemInstruction({ sourceLanguageCode, glossaryEntries })
  };

  return {
    uses: 1,
    expireTime,
    newSessionExpireTime,
    liveConnectConstraints: {
      model: liveTranslateModel,
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
  const liveTranslateModel = options.liveTranslateModel ?? resolveLiveTranslateModel(process.env);
  const glossaryEntries = options.glossary === undefined
    ? undefined
    : await options.glossary.entriesFor(request.targetLanguageCode, { scope: 'live' });
  const configWithGlossary = buildTokenConfig(
    { ...request, liveTranslateModel, ...(glossaryEntries === undefined ? {} : { glossaryEntries }) },
    now
  );
  const client = options.client || (await createGenAiClient(process.env.GEMINI_API_KEY));

  try {
    const token = await client.authTokens.create({ config: configWithGlossary });
    return {
      token: token.name,
      expiresAt: configWithGlossary.expireTime,
      liveConnectModel: liveTranslateModel,
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

export function resolveLiveTranslateModel(env = process.env) {
  const value = env.LIVE_TRANSLATE_MODEL;

  if (value === undefined) {
    return DEFAULT_LIVE_TRANSLATE_MODEL;
  }

  if (typeof value !== 'string') {
    throw new Error('Invalid LIVE_TRANSLATE_MODEL');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('Invalid LIVE_TRANSLATE_MODEL');
  }

  return trimmed;
}

function glossaryInstruction(entries) {
  return [
    'Glossary instructions: when a source term occurs, use its specified target translation in both translated speech audio and output transcription.',
    'Do not say or write the source term in the translated output when a required translation is provided.',
    ...entries.map((entry) => `Source term: ${entry.source}\nRequired translation: ${entry.target}`)
  ].join('\n');
}

function buildSystemInstruction({ sourceLanguageCode, glossaryEntries }) {
  const parts = [
    [
      `Primary input language hint: ${sourceLanguageCode}.`,
      'Use this as a soft hint for the main speech context.',
      `The speaker may still mix ${sourceLanguageCode} with English, Taiwanese, or other languages.`,
      `Do not force all speech to be interpreted as ${sourceLanguageCode}; detect and preserve mixed-language meaning when present.`,
      'Preserve every spoken digit, number, and punctuation mark in the translated output.',
      'Do not skip, merge, reorder, or silently omit any digit in a number sequence; the translated speech audio and output transcription must contain the same complete numeric content.'
    ].join(' ')
  ];

  if (Array.isArray(glossaryEntries) && glossaryEntries.length > 0) {
    parts.push(glossaryInstruction(glossaryEntries));
  }

  return {
    parts: [
      {
        text: parts.join('\n\n')
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
