import {
  formatSavedSessionExport as defaultFormatSavedSessionExport
} from '../lib/sessionRecordExport.js';
import {
  formatTranscriptExport as defaultFormatTranscriptExport
} from '../lib/transcriptExport.js';
import {
  exportCuesToSrt as defaultExportCuesToSrt,
  exportCuesToTxt as defaultExportCuesToTxt,
  exportCuesToVtt as defaultExportCuesToVtt
} from '../lib/subtitleCueExport.js';

export function createExportApplicationService({
  formatTranscriptExport = defaultFormatTranscriptExport,
  formatSavedSessionExport = defaultFormatSavedSessionExport,
  exportCuesToTxt = defaultExportCuesToTxt,
  exportCuesToSrt = defaultExportCuesToSrt,
  exportCuesToVtt = defaultExportCuesToVtt
} = {}) {
  assertFunction(formatTranscriptExport, 'formatTranscriptExport');
  assertFunction(formatSavedSessionExport, 'formatSavedSessionExport');
  assertFunction(exportCuesToTxt, 'exportCuesToTxt');
  assertFunction(exportCuesToSrt, 'exportCuesToSrt');
  assertFunction(exportCuesToVtt, 'exportCuesToVtt');

  function exportTranscript({ items, cues = [], options = {} } = {}) {
    if (Array.isArray(cues) && cues.length > 0 && options.format === 'txt') {
      return exportCuesToTxt(cues, { ...options });
    }
    if (Array.isArray(cues) && cues.length > 0 && options.format === 'srt') {
      return exportCuesToSrt(cues, { ...options });
    }
    if (Array.isArray(cues) && cues.length > 0 && options.format === 'vtt') {
      return exportCuesToVtt(cues, { ...options });
    }
    return formatTranscriptExport(items, { ...options });
  }

  return Object.freeze({
    exportTranscript,

    exportSourceTranscript({ items, options = {} } = {}) {
      return exportTranscript({ items, options: { ...options, stream: 'source' } });
    },

    exportTranslationOutput({ items, options = {} } = {}) {
      return exportTranscript({ items, options: { ...options, stream: 'translation' } });
    },

    exportCombinedSessionView({ sessionDetail, options = {} } = {}) {
      return formatSavedSessionExport(sessionDetail, {
        ...options,
        stream: options.stream ?? 'both'
      });
    }
  });
}

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function.`);
  }
}
