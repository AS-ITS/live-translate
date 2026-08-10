const DEFAULT_MAX_CHARS_BY_LANGUAGE = Object.freeze({
  'zh-Hant': 16,
  'zh-Hans': 16,
  ja: 18,
  ko: 22,
  en: 40,
  es: 42,
  fr: 42,
  de: 38
});

const DEFAULT_OVERLAP_TOLERANCE_MS = 1000;
const STREAMS = new Set(['source', 'translation', 'both']);
const PUNCTUATION_ONLY = /^[\s\p{P}\p{S}]+$/u;
const PROTECTED_TOKEN = /https?:\/\/[^\s]+|www\.[^\s]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\d+(?:[.,]\d+)+(?:\s*[A-Za-z%°]+)?|\d{1,4}[./-]\d{1,4}(?:[./-]\d{1,4})?|\d+(?:\.\d+)?\s*[A-Za-z%°]+/iu;
const WORD_TOKEN = /[\p{L}\p{N}_]+(?:['’.-][\p{L}\p{N}_]+)*/u;
const CJK_TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function normalizeExportableCues(cues = [], options = {}) {
  const stream = normalizeStream(options.stream);
  const byCueId = new Map();

  for (const cue of Array.isArray(cues) ? cues : []) {
    if (cue?.status !== 'final') continue;
    const text = textForStream(cue, stream);
    if (!text) continue;

    if (typeof cue.cueId !== 'string' || cue.cueId.trim() === '') {
      throw exportError('Cue is missing cueId.', 'subtitle_cue_invalid');
    }
    const existing = byCueId.get(cue.cueId);
    if (existing) {
      if (!sameCuePayload(existing, cue)) {
        throw exportError(`Cue ${cue.cueId} has conflicting payload.`, 'subtitle_cue_conflict');
      }
      continue;
    }
    byCueId.set(cue.cueId, { ...cue, sourceText: cue.sourceText?.trim(), translatedText: cue.translatedText?.trim() });
  }

  const normalized = [...byCueId.values()];
  const sequenceOwners = new Map();
  for (const cue of normalized) {
    if (!Number.isInteger(cue.sequence) || cue.sequence < 1) {
      throw exportError(`Cue ${cue.cueId} has an invalid sequence.`, 'subtitle_cue_invalid');
    }
    const owner = sequenceOwners.get(cue.sequence);
    if (owner && owner !== cue.cueId) {
      throw exportError(`Cue sequence ${cue.sequence} is shared by ${owner} and ${cue.cueId}.`, 'subtitle_cue_sequence_conflict');
    }
    sequenceOwners.set(cue.sequence, cue.cueId);
  }

  return normalized.sort((left, right) => left.sequence - right.sequence || left.cueId.localeCompare(right.cueId));
}

export function normalizeCueTimeline(cues = [], options = {}) {
  const overlapToleranceMs = Number.isFinite(options.overlapToleranceMs)
    ? Math.max(0, options.overlapToleranceMs)
    : DEFAULT_OVERLAP_TOLERANCE_MS;
  let previous = null;

  return cues.map((cue) => {
    if (!Number.isFinite(cue.startTimeMs) || !Number.isFinite(cue.endTimeMs) || cue.startTimeMs < 0 || cue.endTimeMs <= cue.startTimeMs) {
      throw exportError(`Cue ${cue.cueId} has an invalid timeline.`, 'subtitle_cue_invalid');
    }
    const next = { ...cue };
    if (previous && next.startTimeMs < previous.endTimeMs) {
      const overlapMs = previous.endTimeMs - next.startTimeMs;
      if (overlapMs > overlapToleranceMs) {
        throw exportError(`Cue ${cue.cueId} overlaps the previous cue by ${overlapMs}ms.`, 'subtitle_cue_timeline_conflict');
      }
      next.startTimeMs = previous.endTimeMs + 1;
      if (next.endTimeMs <= next.startTimeMs) {
        throw exportError(`Cue ${cue.cueId} cannot be normalized without losing its duration.`, 'subtitle_cue_timeline_conflict');
      }
    }
    previous = next;
    return next;
  });
}

export function wrapSubtitleText(text, languageCode, options = {}) {
  const normalized = normalizeExportText(text);
  if (!normalized) return '';
  const effectiveLanguageCode = languageCodeForText(normalized, languageCode);
  const maxChars = options.maxChars ?? options.maxCharsByLanguage?.[effectiveLanguageCode] ?? DEFAULT_MAX_CHARS_BY_LANGUAGE[effectiveLanguageCode] ?? 40;
  if (normalized.length <= maxChars) return normalized;
  const tokens = tokenizeForWrapping(normalized);
  const lines = [''];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const current = lines.at(-1);
    const separator = needsWordSeparator(current, token) ? ' ' : '';
    const candidate = `${current}${separator}${token}`;
    const nextToken = tokens[index + 1];
    if (current && lines.length < 2 && canKeepWordPairTogether(current, token, nextToken)) {
      const pair = `${token}${needsWordSeparator(token, nextToken) ? ' ' : ''}${nextToken}`;
      const pairCandidate = `${current}${separator}${pair}`;
      if (pair.length <= maxChars && pairCandidate.length > maxChars) {
        lines.push(pair);
        index += 1;
        continue;
      }
    }
    if (current && !isPunctuationToken(token) && candidate.length > maxChars && lines.length < 2) {
      lines.push(token);
      continue;
    }
    lines[lines.length - 1] = candidate;
  }

  return lines.filter(Boolean).join('\n');
}

function languageCodeForText(text, languageCode) {
  const cjkLanguage = ['zh-Hant', 'zh-Hans', 'ja', 'ko'].includes(languageCode);
  const hasCjkScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
  if (cjkLanguage && !hasCjkScript) return 'en';
  return languageCode;
}

export function formatSrtTimestamp(milliseconds) {
  return formatTimestamp(milliseconds, ',');
}

export function formatVttTimestamp(milliseconds) {
  return formatTimestamp(milliseconds, '.');
}

export function exportCuesToTxt(cues, options = {}) {
  const stream = normalizeStream(options.stream);
  const normalized = normalizeCueTimeline(normalizeExportableCues(cues, { ...options, stream }), options);
  if (normalized.length === 0) throw exportError('No exportable subtitle cues.', 'subtitle_cue_empty');

  if (stream === 'both') {
    const source = normalized.map((cue) => cue.sourceText?.trim()).filter(Boolean);
    const translation = normalized.map((cue) => cue.translatedText?.trim()).filter(Boolean);
    const sections = [];
    if (source.length) sections.push(`Source\n${source.join('\n')}`);
    if (translation.length) sections.push(`Translation\n${translation.join('\n')}`);
    return `${sections.join('\n\n')}\n`;
  }

  return `${normalized.map((cue) => textForStream(cue, stream)).join('\n')}\n`;
}

export function exportCuesToSrt(cues, options = {}) {
  return formatTimedCueExport(cues, { ...options, format: 'srt' });
}

export function exportCuesToVtt(cues, options = {}) {
  return formatTimedCueExport(cues, { ...options, format: 'vtt' });
}

export function canExportCues(cues, options = {}) {
  try {
    const stream = normalizeStream(options.stream);
    if ((options.format === 'srt' || options.format === 'vtt') && stream === 'both') return false;
    const normalized = normalizeCueTimeline(normalizeExportableCues(cues, { ...options, stream }), options);
    return normalized.length > 0;
  } catch {
    return false;
  }
}

function formatTimedCueExport(cues, options) {
  const stream = normalizeStream(options.stream);
  if (stream === 'both') throw new Error('SRT and VTT export support one subtitle stream at a time.');
  const normalized = normalizeCueTimeline(normalizeExportableCues(cues, { ...options, stream }), options);
  if (normalized.length === 0) throw exportError('No exportable subtitle cues.', 'subtitle_cue_empty');
  const blocks = normalized.map((cue, index) => {
    const text = wrapSubtitleText(textForStream(cue, stream), languageForStream(cue, stream), options);
    const timestamps = `${options.format === 'srt' ? formatSrtTimestamp(cue.startTimeMs) : formatVttTimestamp(cue.startTimeMs)} --> ${options.format === 'srt' ? formatSrtTimestamp(cue.endTimeMs) : formatVttTimestamp(cue.endTimeMs)}`;
    return options.format === 'srt' ? `${index + 1}\n${timestamps}\n${text}` : `${timestamps}\n${text}`;
  });
  return options.format === 'srt' ? `${blocks.join('\n\n')}\n` : `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

function normalizeStream(stream = 'translation') {
  if (!STREAMS.has(stream)) throw new Error('Unsupported subtitle cue stream.');
  return stream;
}

function textForStream(cue, stream) {
  if (stream === 'source') return validCueText(cue?.sourceText) ? cue.sourceText.trim() : '';
  if (stream === 'translation') return validCueText(cue?.translatedText) ? cue.translatedText.trim() : '';
  return validCueText(cue?.sourceText) || validCueText(cue?.translatedText) ? 'cue' : '';
}

function languageForStream(cue, stream) {
  return stream === 'source' ? cue.sourceLanguageCode : cue.targetLanguageCode;
}

function validCueText(text) {
  const normalized = typeof text === 'string' ? text.trim() : '';
  return normalized.length > 0 && !PUNCTUATION_ONLY.test(normalized);
}

function normalizeExportText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function tokenizeForWrapping(text) {
  const tokens = [];
  let remaining = text;
  while (remaining) {
    const protectedMatch = remaining.match(PROTECTED_TOKEN);
    const wordMatch = remaining.match(WORD_TOKEN);
    const cjkMatch = remaining.match(CJK_TOKEN);
    const candidates = [protectedMatch, cjkMatch, wordMatch].filter(Boolean).sort((left, right) => left.index - right.index);
    const match = candidates[0];
    if (!match || match.index > 0) {
      const prefix = remaining.slice(0, match?.index ?? remaining.length);
      for (const character of prefix.trim()) tokens.push(character);
      remaining = match ? remaining.slice(match.index) : '';
      continue;
    }
    tokens.push(match[0]);
    remaining = remaining.slice(match[0].length).trimStart();
  }
  return tokens;
}

function needsWordSeparator(current, token) {
  if (!current || isCjkToken(token) || isPunctuationToken(token)) return false;
  return /[\p{L}\p{N}_)]$/u.test(current) && /^[\p{L}\p{N}_([@]/u.test(token);
}

function isCjkToken(token) { return CJK_TOKEN.test(token); }
function isPunctuationToken(token) { return /^[\p{P}\p{S}]+$/u.test(token); }
function canKeepWordPairTogether(current, token, nextToken) {
  return Boolean(
    /[,;:!?，、；：]$/u.test(current)
      && token
      && nextToken
      && WORD_TOKEN.test(token)
      && WORD_TOKEN.test(nextToken)
  );
}

function sameCuePayload(left, right) {
  return ['cueId', 'sessionId', 'segmentId', 'sequence', 'startTimeMs', 'endTimeMs', 'sourceLanguageCode', 'targetLanguageCode', 'sourceText', 'translatedText', 'status', 'finalizedReason'].every((field) => left[field] === right[field]);
}

function formatTimestamp(milliseconds, separator) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw exportError('Timestamp must be a non-negative finite number.', 'subtitle_cue_invalid');
  const totalMs = Math.floor(milliseconds);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(totalMs % 1000).padStart(3, '0')}`;
}

function exportError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
