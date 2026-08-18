import { formatTranscriptArticleText } from './transcript.js';

const FORMATS = ['txt', 'srt', 'vtt'];
const STREAMS = ['source', 'translation'];
const DEFAULT_STREAM = 'translation';
const DEFAULT_FALLBACK_CUE_MS = 2000;
const SUBTITLE_PAUSE_GAP_MS = 1200;

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
      sections.push(['Source', formatTranscriptArticleText(sourceItems)].join('\n'));
    }

    if (translationItems.length > 0) {
      sections.push(['Translation', formatTranscriptArticleText(translationItems)].join('\n'));
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

  return `${formatTranscriptArticleText(selectedItems)}\n`;
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

  const cueItems = buildSubtitleCueItems(items, selectedItems, options);
  const fallbackCueMs = Number.isFinite(options.fallbackCueMs) ? Math.max(0, options.fallbackCueMs) : DEFAULT_FALLBACK_CUE_MS;
  const cues = cueItems.map((item, index) => {
    if (!Number.isFinite(item.startedAt)) {
      throw new Error('Timed transcript export requires item timestamps.');
    }

    const nextItem = cueItems[index + 1];
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
      text: normalizeSubtitleText(item.text)
    };
  });

  return options.format === 'srt' ? formatSrt(cues) : formatVtt(cues);
}

function buildSubtitleCueItems(allItems, selectedItems, options) {
  if (options.stream === 'source') {
    return groupSubtitleItems(selectedItems);
  }

  const sourceItems = selectExportItems(allItems, { ...options, stream: 'source' });
  const sourceCueItems = groupSubtitleItems(sourceItems);
  if (sourceCueItems.length === 0 || !sourceCueItems.every((item) => Number.isFinite(item.startedAt))) {
    return groupSubtitleItems(selectedItems);
  }

  return alignTranslationItemsToSourceCues(selectedItems, sourceCueItems);
}

function alignTranslationItemsToSourceCues(translationItems, sourceCueItems) {
  const translationText = joinSubtitleTextParts(translationItems.map((item) => item.text));
  const cueTexts = splitSubtitleTextByCueCount(translationText, sourceCueItems.length);

  return sourceCueItems.map((sourceCueItem, index) => ({
    ...sourceCueItem,
    stream: 'translation',
    text: cueTexts[index] || ''
  }));
}

function groupSubtitleItems(items) {
  const groups = [];
  let currentGroup = [];

  items.forEach((item, index) => {
    currentGroup.push(item);

    const nextItem = items[index + 1];
    if (!nextItem || shouldEndSubtitleGroup(item, nextItem)) {
      groups.push(createSubtitleGroup(currentGroup));
      currentGroup = [];
    }
  });

  return groups;
}

function shouldEndSubtitleGroup(item, nextItem) {
  return endsWithSentenceBoundary(item.text) || hasSourceSubtitlePause(item, nextItem);
}

function createSubtitleGroup(groupItems) {
  const firstItem = groupItems[0];
  const lastItem = groupItems.at(-1);

  return {
    ...firstItem,
    text: joinSubtitleTextParts(groupItems.map((item) => item.text)),
    startedAt: firstItem.startedAt,
    finalizedAt: validEndTime(lastItem) ? lastItem.finalizedAt : undefined
  };
}

function endsWithSentenceBoundary(text) {
  return /[.!?。！？]$/.test(text);
}

function hasSourceSubtitlePause(item, nextItem) {
  if (!Number.isFinite(nextItem?.startedAt)) {
    return false;
  }

  const itemEndAt = validEndTime(item) ? item.finalizedAt : item.startedAt;
  return Number.isFinite(itemEndAt) && nextItem.startedAt - itemEndAt >= SUBTITLE_PAUSE_GAP_MS;
}

function joinSubtitleTextParts(parts) {
  return normalizeSubtitleText(parts.filter(Boolean).join(' '));
}

function normalizeSubtitleText(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])\s+([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu, '$1$2')
    .replace(/\s+([，。！？、；：])/gu, '$1')
    .replace(/([「『（《])\s+/gu, '$1');
}

function splitSubtitleTextByCueCount(text, cueCount) {
  const normalizedText = normalizeSubtitleText(text);
  if (cueCount <= 1 || normalizedText.length === 0) {
    return [normalizedText];
  }

  const phraseCueTexts = splitSubtitleTextByPhraseUnits(normalizedText, cueCount);
  if (phraseCueTexts) {
    return phraseCueTexts;
  }

  return splitSubtitleTextByLength(normalizedText, cueCount);
}

function splitSubtitleTextByPhraseUnits(text, cueCount) {
  const phraseUnits = buildSubtitlePhraseUnits(text);
  if (phraseUnits.length < cueCount) {
    return null;
  }

  const cueTexts = [];
  let remainingUnits = phraseUnits;

  for (let index = 0; index < cueCount - 1; index += 1) {
    const remainingCueCount = cueCount - index;
    const targetLength = totalTextLength(remainingUnits) / remainingCueCount;
    const unitCount = chooseSubtitleUnitCount(remainingUnits, targetLength, remainingCueCount - 1);
    const cueUnits = remainingUnits.slice(0, unitCount);
    cueTexts.push(joinSubtitleTextParts(cueUnits));
    remainingUnits = remainingUnits.slice(unitCount);
  }

  cueTexts.push(joinSubtitleTextParts(remainingUnits));
  return cueTexts;
}

function buildSubtitlePhraseUnits(text) {
  const units = [];
  const sentenceParts = text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/gu) || [];

  sentenceParts.forEach((sentencePart) => {
    const phraseParts = sentencePart.match(/[^,，;；:：]+[,，;；:：]+|[^,，;；:：]+$/gu) || [];
    units.push(...mergeRepeatedSubtitlePhrases(phraseParts.map(normalizeSubtitleText).filter(Boolean)));
  });

  return units;
}

function mergeRepeatedSubtitlePhrases(phrases) {
  const merged = [];
  let index = 0;

  while (index < phrases.length) {
    const currentPhrase = phrases[index];
    const nextPhrase = phrases[index + 1];

    if (nextPhrase && repeatedSubtitlePhraseKey(currentPhrase) === repeatedSubtitlePhraseKey(nextPhrase)) {
      merged.push(joinSubtitleTextParts([currentPhrase, nextPhrase]));
      index += 2;
      continue;
    }

    merged.push(currentPhrase);
    index += 1;
  }

  return merged;
}

function repeatedSubtitlePhraseKey(phrase) {
  return normalizeSubtitleText(phrase)
    .replace(/[,，;；:：.!?。！？]+$/u, '')
    .trim()
    .toLocaleLowerCase();
}

function chooseSubtitleUnitCount(units, targetLength, remainingCueCount) {
  const maxUnitCount = Math.max(1, units.length - remainingCueCount);
  let bestUnitCount = 1;
  let bestDistance = Infinity;
  let currentLength = 0;

  for (let unitCount = 1; unitCount <= maxUnitCount; unitCount += 1) {
    currentLength += units[unitCount - 1].length;
    const distance = Math.abs(currentLength - targetLength);
    if (distance < bestDistance) {
      bestUnitCount = unitCount;
      bestDistance = distance;
    }
  }

  return bestUnitCount;
}

function totalTextLength(units) {
  return units.reduce((total, unit) => total + unit.length, 0);
}

function splitSubtitleTextByLength(normalizedText, cueCount) {
  const cueTexts = [];
  let remainingText = normalizedText;

  for (let index = 0; index < cueCount - 1; index += 1) {
    const remainingCueCount = cueCount - index;
    if (remainingText.length <= remainingCueCount) {
      cueTexts.push(remainingText.slice(0, 1));
      remainingText = remainingText.slice(1).trim();
      continue;
    }

    const targetIndex = Math.ceil(remainingText.length / remainingCueCount);
    const splitIndex = findSubtitleSplitIndex(remainingText, targetIndex, remainingCueCount - 1);
    cueTexts.push(normalizeSubtitleText(remainingText.slice(0, splitIndex)));
    remainingText = remainingText.slice(splitIndex).trim();
  }

  cueTexts.push(normalizeSubtitleText(remainingText));
  return cueTexts;
}

function findSubtitleSplitIndex(text, targetIndex, remainingCueCount) {
  const maxIndex = Math.max(1, text.length - remainingCueCount);
  const clampedTarget = Math.min(Math.max(1, targetIndex), maxIndex);
  const searchRadius = Math.max(8, Math.ceil(text.length * 0.12));
  const minIndex = Math.max(1, clampedTarget - searchRadius);
  const maxSearchIndex = Math.min(maxIndex, clampedTarget + searchRadius);
  const punctuationSplit = nearestSplitIndex(text, clampedTarget, minIndex, maxSearchIndex, /[.!?。！？,，;；:：]/u, 0);
  if (punctuationSplit !== null) {
    return punctuationSplit;
  }

  const whitespaceSplit = nearestSplitIndex(text, clampedTarget, minIndex, maxSearchIndex, /\s/u, 0);
  if (whitespaceSplit !== null) {
    return whitespaceSplit;
  }

  return clampedTarget;
}

function nearestSplitIndex(text, targetIndex, minIndex, maxIndex, pattern, offset) {
  let bestIndex = null;
  let bestDistance = Infinity;

  for (let index = minIndex; index <= maxIndex; index += 1) {
    if (!pattern.test(text[index - 1])) {
      continue;
    }

    const splitIndex = Math.min(maxIndex, Math.max(minIndex, index + offset));
    const distance = Math.abs(splitIndex - targetIndex);
    if (distance < bestDistance) {
      bestIndex = splitIndex;
      bestDistance = distance;
    }
  }

  return bestIndex;
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
