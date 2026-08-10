import assert from 'node:assert/strict';
import test from 'node:test';
import { createExportApplicationService } from '../../src/application/exportApplicationService.js';

test('export application service delegates source, translation, and combined exports', () => {
  const calls = [];
  const service = createExportApplicationService({
    formatTranscriptExport(items, options) {
      calls.push(['transcript', items, options]);
      return 'transcript-result';
    },
    formatSavedSessionExport(detail, options) {
      calls.push(['saved-session', detail, options]);
      return 'saved-session-result';
    }
  });
  const items = [{ id: 'item-1' }];
  const detail = { sessionRecord: { id: 'session-1' } };
  const sourceOptions = { format: 'txt' };
  const translationOptions = { format: 'srt', timeOrigin: 10 };

  assert.equal(service.exportSourceTranscript({ items, options: sourceOptions }), 'transcript-result');
  assert.equal(service.exportTranslationOutput({ items, options: translationOptions }), 'transcript-result');
  assert.equal(service.exportCombinedSessionView({ sessionDetail: detail, options: { format: 'txt' } }), 'saved-session-result');
  assert.deepEqual(calls, [
    ['transcript', items, { format: 'txt', stream: 'source' }],
    ['transcript', items, { format: 'srt', timeOrigin: 10, stream: 'translation' }],
    ['saved-session', detail, { format: 'txt', stream: 'both' }]
  ]);
  assert.deepEqual(sourceOptions, { format: 'txt' });
  assert.deepEqual(translationOptions, { format: 'srt', timeOrigin: 10 });
});

test('combined export preserves an explicitly selected stream', () => {
  let options;
  const service = createExportApplicationService({
    formatTranscriptExport() {},
    formatSavedSessionExport(_detail, nextOptions) {
      options = nextOptions;
      return 'result';
    }
  });

  service.exportCombinedSessionView({ sessionDetail: {}, options: { format: 'vtt', stream: 'translation' } });

  assert.deepEqual(options, { format: 'vtt', stream: 'translation' });
});

test('export application service propagates helper results and errors unchanged', () => {
  const error = new Error('export failed');
  const service = createExportApplicationService({
    formatTranscriptExport() {
      throw error;
    },
    formatSavedSessionExport() {}
  });

  assert.throws(() => service.exportSourceTranscript({ items: [] }), error);
});

test('factory rejects missing or invalid export helpers deterministically', () => {
  assert.throws(() => createExportApplicationService({ formatTranscriptExport: null }), /formatTranscriptExport must be a function/);
  assert.throws(() => createExportApplicationService({ formatSavedSessionExport: null }), /formatSavedSessionExport must be a function/);
});
