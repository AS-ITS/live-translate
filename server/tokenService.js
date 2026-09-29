import { isSupportedLanguage } from './languages.js';

export const DEFAULT_LIVE_TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview';
export const LIVE_TRANSLATE_MODEL = DEFAULT_LIVE_TRANSLATE_MODEL;
export const DEFAULT_SOURCE_LANGUAGE_CODE = 'zh-Hant';
export const LIVE_SESSION_MODES = Object.freeze(['translation', 'transcription']);

export function classifyGeminiProviderError(error = {}) {
  const status = providerStatusCode(error);
  const text = providerErrorText(error);
  if (status === 401 || /invalid\s*(api\s*)?key|api key.*invalid|unauthenticated/.test(text)) return 'invalid_api_key';
  if (status === 403 || /permission|forbidden|not authorized|api.*not enabled|unavailable/.test(text)) return 'permission_api_unavailable';
  if (status === 404 || /model.*(not found|invalid)|unknown model/.test(text)) return 'invalid_model';
  if (/context(window| compression)|compression.*(config|unsupported)|invalid.*(live|session).*config|configuration.*invalid|(?:parameter|field|property).*not supported|unsupported.*(?:parameter|field|property|config)/.test(text)) return 'invalid_live_config';
  if (status === 429 || /rate.?limit|quota|resource.?exhausted|too many requests/.test(text)) return 'rate_limit';
  return 'unknown_provider_error';
}

export function safeGeminiProviderDiagnostic(error = {}) {
  const status = providerStatusCode(error);
  const code = providerCode(error);
  const message = sanitizeProviderMessage(error.message || error.statusMessage || error.error?.message);
  return {
    category: classifyGeminiProviderError(error),
    ...(status === null ? {} : { status }),
    ...(code ? { code } : {}),
    ...(message ? { message } : {})
  };
}

export function normalizeTokenRequest(body = {}) {
  const mode = body.mode === undefined ? 'translation' : body.mode;
  if (!LIVE_SESSION_MODES.includes(mode)) {
    const error = new Error('Unsupported live session mode');
    error.status = 400;
    error.code = 'unsupported_live_session_mode';
    throw error;
  }
  const targetLanguageCode = Object.hasOwn(body, 'targetLanguageCode') ? body.targetLanguageCode : 'en';
  const sourceLanguageCode = Object.hasOwn(body, 'sourceLanguageCode')
    ? body.sourceLanguageCode
    : DEFAULT_SOURCE_LANGUAGE_CODE;
  const echoTargetLanguage =
    typeof body.echoTargetLanguage === 'boolean' ? body.echoTargetLanguage : true;
  const meetingId = body.meetingId === undefined ? undefined : body.meetingId;
  if (meetingId !== undefined && (typeof meetingId !== 'string' || meetingId.trim() === '')) {
    const error = new Error('Invalid meetingId');
    error.status = 400;
    throw error;
  }

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

  return {
    ...(mode === 'translation' ? {} : { mode }),
    targetLanguageCode,
    sourceLanguageCode,
    echoTargetLanguage,
    ...(meetingId === undefined ? {} : { meetingId })
  };
}

export function buildTokenConfig({
  mode = 'translation',
  targetLanguageCode,
  sourceLanguageCode = DEFAULT_SOURCE_LANGUAGE_CODE,
  echoTargetLanguage,
  glossaryEntries,
  liveTranslateModel
}, now = new Date()) {
  const expireTime = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(now.getTime() + 60 * 1000).toISOString();
  const translationConfig = {
    targetLanguageCode,
    echoTargetLanguage
  };
  const liveModel = liveTranslateModel || (mode === 'transcription' ? resolveLiveTranscriptionModel() : resolveLiveTranslateModel());
  const liveConnectConfig = mode === 'transcription'
    ? {
      responseModalities: ['TEXT'],
      inputAudioTranscription: {
        mode: 'VERBATIM'
      },
      sessionResumption: {},
      contextWindowCompression: {
        slidingWindow: {}
      },
      realtimeInputConfig: { automaticActivityDetection: {} },
      systemInstruction: buildSystemInstruction({ sourceLanguageCode, glossaryEntries })
    }
    : {
    responseModalities: ['AUDIO'],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      // Keep the provider contract explicit. audioStreamEnd is valid only
      // when automatic activity detection is enabled.
      automaticActivityDetection: {}
    },
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
      model: liveModel,
      config: liveConnectConfig
    },
    httpOptions: {
      apiVersion: 'v1beta'
    }
  };
}

export async function createLiveToken(body, options = {}) {
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : options.apiKey;
  if (!apiKey && !options.client) {
    const error = new Error('GEMINI_API_KEY is not configured');
    error.status = 500;
    throw error;
  }

  const request = normalizeTokenRequest(body);
  const now = options.now || new Date();
  const liveTranslateModel = options.liveTranslateModel ?? resolveLiveTranslateModel(process.env);
  const liveModel = request.mode === 'transcription'
    ? (options.liveTranscriptionModel ?? resolveLiveTranscriptionModel(process.env))
    : liveTranslateModel;
  const meeting = request.meetingId && options.meetingRepository
    ? await options.meetingRepository.getMeeting(request.meetingId)
    : null;
  if (request.meetingId && !meeting) {
    const error = new Error('Meeting not found');
    error.status = 404;
    error.code = 'meeting_not_found';
    throw error;
  }
  const glossaryEntries = meeting
    ? [...(meeting.glossaryEntries || []), ...privateGlossaryEntriesForTarget(meeting.privateGlossaryEntries, request.targetLanguageCode)]
    : options.glossary === undefined
      ? undefined
      : await options.glossary.entriesFor(request.targetLanguageCode, { scope: 'live' });
  const targetGlossaryEntries = glossaryEntries === undefined
    ? undefined
    : glossaryEntries
      .map((entry) => ({
        source: entry.source,
        target: entry.target || entry.translations?.[request.targetLanguageCode],
        replacementAliases: Array.isArray(entry.replacementAliases)
          ? entry.replacementAliases
          : entry.replacementAliases?.[request.targetLanguageCode] || []
      }))
      .filter((entry) => typeof entry.target === 'string' && entry.target.trim() !== '');
  const configWithGlossary = buildTokenConfig(
    { ...request, liveTranslateModel: liveModel, ...(targetGlossaryEntries === undefined ? {} : { glossaryEntries: targetGlossaryEntries }) },
    now
  );
  const client = options.client || (await createGenAiClient(apiKey));

  try {
    const token = await client.authTokens.create({ config: configWithGlossary });
    return {
      token: token.name,
      expiresAt: configWithGlossary.expireTime,
      liveConnectModel: liveModel,
      liveConnectConfig: configWithGlossary.liveConnectConstraints.config,
      liveGlossaryEntries: targetGlossaryEntries || []
    };
  } catch (cause) {
    const error = new Error('Failed to create Gemini ephemeral token');
    error.status = 502;
    error.cause = cause;
    error.providerDiagnostic = {
      ...safeGeminiProviderDiagnostic(cause),
      model: liveModel,
      apiVersion: configWithGlossary.httpOptions.apiVersion
    };
    throw error;
  }
}

function providerStatusCode(error) {
  const value = error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.error?.status;
  return Number.isInteger(value) ? value : null;
}

function providerCode(error) {
  const value = error?.code ?? error?.error?.code ?? error?.response?.data?.error?.status;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function providerErrorText(error) {
  return [error?.message, error?.statusMessage, error?.error?.message, error?.response?.data?.error?.message]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

function sanitizeProviderMessage(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const sanitized = value
    .replace(/https?:\/\/[^\s)]+/gi, '[redacted-url]')
    .replace(/\b(?:bearer\s+)?(?:AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]+)\b/gi, '[redacted-secret]')
    .replace(/(authorization|api[-_ ]?key|token|resumption(?:[-_ ]?handle)?)(\s*[:=]\s*)([^,;\s]+)/gi, '$1$2[redacted]');
  return sanitized.length > 300 ? `${sanitized.slice(0, 297)}...` : sanitized;
}

export function resolveLiveTranscriptionModel(env = process.env) {
  const value = env.LIVE_TRANSCRIPTION_MODEL;
  if (value === undefined) return 'gemini-3.5-transcribe-live';
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Invalid LIVE_TRANSCRIPTION_MODEL');
  return value.trim();
}

function privateGlossaryEntriesForTarget(entries, targetLanguageCode) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    source: entry.source,
    target: entry.translations?.[targetLanguageCode],
    replacementAliases: entry.replacementAliases?.[targetLanguageCode] || []
  })).filter((entry) => typeof entry.target === 'string' && entry.target.trim() !== '');
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
      'Translate faithfully without summarizing, shortening, merging, or omitting any spoken word.',
      'Preserve every spoken digit, number, and punctuation mark in the translated output.',
      'Do not skip, merge, reorder, or silently omit any digit in a number sequence.',
      'Preserve times exactly: spoken 4:50 or 下午4點50分 must not become 4:00, 4:05, or any guessed time.',
      'Do not round, normalize, infer, or replace a time or number with a different value.',
      'Speak the complete translation aloud exactly once; the translated speech audio and output transcription must contain the same complete content.'
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
      apiVersion: 'v1beta'
    }
  });
}
