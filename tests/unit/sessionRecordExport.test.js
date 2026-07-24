import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSavedSessionFileName,
  canExportSavedSession,
  formatSavedSessionExport
} from '../../src/lib/sessionRecordExport.js';

const baseSessionRecord = Object.freeze({
  id: 'session-1',
  startedAt: new Date(2026, 6, 7, 8, 9, 10).getTime(),
  targetLanguageCode: 'zh-Hant'
});

const sourceFinal = Object.freeze({
  id: 'source-1',
  sessionId: 'session-1',
  stream: 'source',
  status: 'final',
  text: 'Hello.',
  sequence: 1,
  startedAt: baseSessionRecord.startedAt + 1000,
  finalizedAt: baseSessionRecord.startedAt + 1800
});

const translationFinal = Object.freeze({
  id: 'translation-1',
  sessionId: 'session-1',
  stream: 'translation',
  status: 'final',
  text: 'Bonjour.',
  sequence: 2,
  startedAt: baseSessionRecord.startedAt + 2000,
  finalizedAt: baseSessionRecord.startedAt + 3000
});

test('TXT source export', () => {
  assert.equal(formatSavedSessionExport(detail(), { format: 'txt', stream: 'source' }), 'Hello.\n');
  assert.equal(canExportSavedSession(detail(), { format: 'txt', stream: 'source' }), true);
});

test('TXT translation export', () => {
  assert.equal(formatSavedSessionExport(detail(), { format: 'txt', stream: 'translation' }), 'Bonjour.\n');
});

test('TXT saved export preserves article mode', () => {
  const output = formatSavedSessionExport(
    detail({
      transcriptItems: [
        { ...translationFinal, id: 'translation-2', text: 'second', sequence: 2 },
        { ...translationFinal, id: 'translation-1', text: 'first', sequence: 1 }
      ]
    }),
    { format: 'txt', stream: 'translation' }
  );

  assert.equal(output, 'first second\n');
});

test('TXT both export', () => {
  assert.equal(formatSavedSessionExport(detail(), { format: 'txt', stream: 'both' }), 'Source\nHello.\n\nTranslation\nBonjour.\n');
});

test('SRT uses sessionRecord.startedAt as timeOrigin', () => {
  assert.equal(
    formatSavedSessionExport(detail(), { format: 'srt', stream: 'translation' }),
    '1\n00:00:01,000 --> 00:00:01,800\nBonjour.\n'
  );
});

test('VTT uses sessionRecord.startedAt as timeOrigin', () => {
  assert.equal(
    formatSavedSessionExport(detail(), { format: 'vtt', stream: 'source' }),
    'WEBVTT\n\n00:00:01.000 --> 00:00:01.800\nHello.\n'
  );
});

test('SRT/VTT reject both stream', () => {
  assert.equal(canExportSavedSession(detail(), { format: 'srt', stream: 'both' }), false);
  assert.throws(
    () => formatSavedSessionExport(detail(), { format: 'vtt', stream: 'both' }),
    /SRT and VTT export support one transcript stream at a time/
  );
});

test('SRT/VTT reject non-numeric startedAt', () => {
  const sessionDetail = detail({ sessionRecord: { ...baseSessionRecord, startedAt: '2026-07-07T00:00:00.000Z' } });

  assert.equal(canExportSavedSession(sessionDetail, { format: 'srt', stream: 'source' }), false);
  assert.throws(
    () => formatSavedSessionExport(sessionDetail, { format: 'vtt', stream: 'source' }),
    /numeric session startedAt/
  );
});

test('no final transcript rejects export', () => {
  const sessionDetail = detail({
    transcriptItems: [{ ...sourceFinal, status: 'partial', text: 'draft' }]
  });

  assert.equal(canExportSavedSession(sessionDetail, { format: 'txt', stream: 'source' }), false);
  assert.throws(() => formatSavedSessionExport(sessionDetail, { format: 'txt', stream: 'source' }), /No exportable transcript text/);
});

test('partial items are excluded', () => {
  const output = formatSavedSessionExport(
    detail({
      transcriptItems: [
        { ...sourceFinal, status: 'partial', text: 'partial', sequence: 1 },
        { ...sourceFinal, id: 'source-2', text: 'final', sequence: 2 }
      ]
    }),
    { format: 'txt', stream: 'source' }
  );

  assert.equal(output, 'final\n');
});

test('filename includes date, language, stream, and extension', () => {
  assert.equal(
    buildSavedSessionFileName(baseSessionRecord, { format: 'vtt', stream: 'translation' }),
    'live-translate-session-20260707-080910-zh-Hant-translation.vtt'
  );
});

test('filename sanitizes unsafe values', () => {
  assert.equal(
    buildSavedSessionFileName(
      {
        ...baseSessionRecord,
        targetLanguageCode: '../zh Hant/unsafe'
      },
      { format: 'txt', stream: 'both' }
    ),
    'live-translate-session-20260707-080910-zh-Hant-unsafe-both.txt'
  );
});

test('input is not mutated', () => {
  const sessionDetail = detail();
  const before = JSON.stringify(sessionDetail);

  formatSavedSessionExport(sessionDetail, { format: 'txt', stream: 'both' });
  canExportSavedSession(sessionDetail, { format: 'srt', stream: 'source' });
  buildSavedSessionFileName(sessionDetail.sessionRecord, { format: 'srt', stream: 'source' });

  assert.equal(JSON.stringify(sessionDetail), before);
});

function detail(overrides = {}) {
  return {
    sessionRecord: overrides.sessionRecord || { ...baseSessionRecord },
    transcriptItems: overrides.transcriptItems || [{ ...sourceFinal }, { ...translationFinal }]
  };
}
