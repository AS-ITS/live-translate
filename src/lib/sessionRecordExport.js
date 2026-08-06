import { canExportTranscript, formatTranscriptExport } from './transcriptExport.js';
import { canExportCues, exportCuesToSrt, exportCuesToTxt, exportCuesToVtt } from './subtitleCueExport.js';

const FORMATS = new Set(['txt', 'srt', 'vtt']);
const STREAMS = new Set(['source', 'translation', 'both']);
const DEFAULT_FORMAT = 'txt';
const DEFAULT_STREAM = 'translation';

export function canExportSavedSession(sessionDetail, options = {}) {
  try {
    const { format, stream, timeOrigin } = buildExportOptions(sessionDetail, options);

    if ((format === 'srt' || format === 'vtt') && stream === 'both') {
      return false;
    }

    if (hasPersistedCues(sessionDetail)) {
      return canExportCues(sessionDetail.cues, { ...options, format, stream });
    }

    return canExportTranscript(sessionDetail?.transcriptItems, {
      ...options,
      format,
      stream,
      timeOrigin
    });
  } catch {
    return false;
  }
}

export function formatSavedSessionExport(sessionDetail, options = {}) {
  const { format, stream, timeOrigin } = buildExportOptions(sessionDetail, options);

  if (hasPersistedCues(sessionDetail)) {
    const cueOptions = { ...options, format, stream };
    if (format === 'txt') return exportCuesToTxt(sessionDetail.cues, cueOptions);
    if (format === 'srt') return exportCuesToSrt(sessionDetail.cues, cueOptions);
    return exportCuesToVtt(sessionDetail.cues, cueOptions);
  }

  return formatTranscriptExport(sessionDetail.transcriptItems, {
    ...options,
    format,
    stream,
    timeOrigin
  });
}

function hasPersistedCues(sessionDetail) {
  return Array.isArray(sessionDetail?.cues) && sessionDetail.cues.length > 0;
}

export function buildSavedSessionFileName(sessionRecord, options = {}) {
  const format = normalizeFormat(options.format || DEFAULT_FORMAT);
  const stream = normalizeStream(options.stream || DEFAULT_STREAM);
  const startedAt = sessionRecord?.startedAt;

  if (!Number.isFinite(startedAt)) {
    throw new Error('Saved session export file name requires numeric startedAt.');
  }

  const stamp = formatDateStamp(new Date(startedAt));
  const language = sanitizeFileNamePart(sessionRecord?.targetLanguageCode || 'unknown-language');
  const safeStream = sanitizeFileNamePart(stream);

  return `live-translate-session-${stamp}-${language}-${safeStream}.${format}`;
}

function buildExportOptions(sessionDetail, options) {
  if (!sessionDetail?.sessionRecord || (!Array.isArray(sessionDetail.transcriptItems) && !Array.isArray(sessionDetail.cues))) {
    throw new Error('Saved session export requires session detail.');
  }

  const format = normalizeFormat(options.format || DEFAULT_FORMAT);
  const stream = normalizeStream(options.stream || DEFAULT_STREAM);
  const timeOrigin = sessionDetail.sessionRecord.startedAt;

  if ((format === 'srt' || format === 'vtt') && !hasPersistedCues(sessionDetail) && !Number.isFinite(timeOrigin)) {
    throw new Error('Saved subtitle export requires numeric session startedAt.');
  }

  return { format, stream, timeOrigin };
}

function normalizeFormat(format) {
  if (!FORMATS.has(format)) {
    throw new Error('Unsupported saved session export format.');
  }

  return format;
}

function normalizeStream(stream) {
  if (!STREAMS.has(stream)) {
    throw new Error('Unsupported saved session export stream.');
  }

  return stream;
}

function formatDateStamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Saved session export file name requires a valid startedAt date.');
  }

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function sanitizeFileNamePart(value) {
  const sanitized = String(value)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');

  return sanitized || 'unknown';
}

function pad(value, size = 2) {
  return String(value).padStart(size, '0');
}
