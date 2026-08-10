import {
  formatSavedSessionExport as defaultFormatSavedSessionExport
} from '../lib/sessionRecordExport.js';
import {
  formatTranscriptExport as defaultFormatTranscriptExport
} from '../lib/transcriptExport.js';

export function createExportApplicationService({
  formatTranscriptExport = defaultFormatTranscriptExport,
  formatSavedSessionExport = defaultFormatSavedSessionExport
} = {}) {
  assertFunction(formatTranscriptExport, 'formatTranscriptExport');
  assertFunction(formatSavedSessionExport, 'formatSavedSessionExport');

  return Object.freeze({
    exportSourceTranscript({ items, options = {} } = {}) {
      return formatTranscriptExport(items, { ...options, stream: 'source' });
    },

    exportTranslationOutput({ items, options = {} } = {}) {
      return formatTranscriptExport(items, { ...options, stream: 'translation' });
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
