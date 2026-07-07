const FORMATS = ['txt', 'srt', 'vtt'];
const STREAMS = ['source', 'translation'];
const DEFAULT_STREAM = 'translation';
const DEFAULT_FALLBACK_CUE_MS = 2000;

export function formatTranscriptExport(items, options = {}) {
  const format = normalizeFormat(options.format);
  const stream = options.stream || DEFAULT_STREAM;

  if (format === 'txt') {
    return formatTxt(items, { ...options, stream });
  }

  if (stream === 'both') {
    throw new Error('SRT and VTT export support one transcript stream at a time.');
  }

  return formatTimedCues(items, { ...options, format, stream });
}

export function canExportTranscript(items, options = {}) {
  try {
    const format = normalizeFormat(options.format);
    const stream = options.stream || DEFAULT_STREAM;

    if ((format === 'srt' || format === 'vtt') && stream === 'both') {
      return false;
    }

    const filteredItems = selectExportItems(items, { ...options, stream });
    if (filteredItems.length === 0) {
      return false;
    }

    if (format === 'srt' || format === 'vtt') {
      return Number.isFinite(options.timeOrigin) && filteredItems.every((item) => Number.isFinite(item.startedAt));
    }

    return true;
  } catch {
    return false;
  }
}

export function buildTranscriptFileName(options = {}) {
  const format = normalizeFormat(options.format || 'txt');
  const now = options.now || new Date();

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('Export file name requires a valid date.');
  }

  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('');

  return `live-translate-transcript-${stamp}.${format}`;
}

function formatTxt(items, options) {
  const stream = options.stream || DEFAULT_STREAM;

  if (stream === 'both') {
    const sourceItems = selectExportItems(items, { ...options, stream: 'source' });
    const translationItems = selectExportItems(items, { ...options, stream: 'translation' });
    const sections = [];

    if (sourceItems.length > 0) {
      sections.push(['Source', ...sourceItems.map((item) => item.text)].join('\n'));
    }

    if (translationItems.length > 0) {
      sections.push(['Translation', ...translationItems.map((item) => item.text)].join('\n'));
    }

    if (sections.length === 0) {
      throw new Error('No exportable transcript text.');
    }

    return `${sections.join('\n\n')}\n`;
  }

  const selectedItems = selectExportItems(items, options);
  if (selectedItems.length === 0) {
    throw new Error('No exportable transcript text.');
  }

  return `${selectedItems.map((item) => item.text).join('\n')}\n`;
}

function formatTimedCues(items, options) {
  const timeOrigin = options.timeOrigin;
  if (!Number.isFinite(timeOrigin)) {
    throw new Error('Timed transcript export requires timeOrigin.');
  }

  const selectedItems = selectExportItems(items, options);
  if (selectedItems.length === 0) {
    throw new Error('No exportable transcript text.');
  }

  const fallbackCueMs = Number.isFinite(options.fallbackCueMs) ? Math.max(0, options.fallbackCueMs) : DEFAULT_FALLBACK_CUE_MS;
  const cues = selectedItems.map((item, index) => {
    if (!Number.isFinite(item.startedAt)) {
      throw new Error('Timed transcript export requires item timestamps.');
    }

    const nextItem = selectedItems[index + 1];
    const derivedEndAt = validEndTime(item)
      ? item.finalizedAt
      : Number.isFinite(nextItem?.startedAt)
        ? nextItem.startedAt
        : item.startedAt + fallbackCueMs;
    const endAt = derivedEndAt > item.startedAt ? derivedEndAt : item.startedAt + fallbackCueMs;
    const startMs = Math.max(0, item.startedAt - timeOrigin);
    const endMs = Math.max(startMs, endAt - timeOrigin);

    return {
      index: index + 1,
      startMs,
      endMs,
      text: item.text
    };
  });

  return options.format === 'srt' ? formatSrt(cues) : formatVtt(cues);
}

function formatSrt(cues) {
  return `${cues
    .map((cue) => `${cue.index}\n${formatTimestamp(cue.startMs, ',')} --> ${formatTimestamp(cue.endMs, ',')}\n${cue.text}`)
    .join('\n\n')}\n`;
}

function formatVtt(cues) {
  return `WEBVTT\n\n${cues
    .map((cue) => `${formatTimestamp(cue.startMs, '.')} --> ${formatTimestamp(cue.endMs, '.')}\n${cue.text}`)
    .join('\n\n')}\n`;
}

function selectExportItems(items, options) {
  const stream = options.stream || DEFAULT_STREAM;
  if (stream !== 'both' && !STREAMS.includes(stream)) {
    throw new Error('Unsupported transcript stream.');
  }

  const includePartials = options.includePartials === true;

  return [...(Array.isArray(items) ? items : [])]
    .filter((item) => stream === 'both' || item.stream === stream)
    .filter((item) => includePartials || item.status === 'final')
    .map((item) => ({
      ...item,
      text: item.text?.trim() || ''
    }))
    .filter((item) => item.text)
    .sort((first, second) => (first.sequence || 0) - (second.sequence || 0));
}

function validEndTime(item) {
  return Number.isFinite(item.finalizedAt) && item.finalizedAt > item.startedAt;
}

function normalizeFormat(format) {
  if (!FORMATS.includes(format)) {
    throw new Error('Unsupported transcript export format.');
  }

  return format;
}

function formatTimestamp(milliseconds, separator) {
  const totalMs = Math.max(0, Math.floor(milliseconds));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(ms, 3)}`;
}

function pad(value, size = 2) {
  return String(value).padStart(size, '0');
}
