import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTranscriptFileName, canExportTranscript, formatTranscriptExport } from '../../src/lib/transcriptExport.js';

const sourceFinal = {
  id: 'source-1',
  stream: 'source',
  status: 'final',
  text: 'Hello.',
  sequence: 1,
  startedAt: 1000,
  finalizedAt: 2000
};

const translationFinal = {
  id: 'translation-2',
  stream: 'translation',
  status: 'final',
  text: 'Bonjour.',
  sequence: 2,
  startedAt: 2200,
  finalizedAt: 3200
};

test('TXT exports source items', () => {
  const output = formatTranscriptExport([sourceFinal, translationFinal], {
    format: 'txt',
    stream: 'source'
  });

  assert.equal(output, 'Hello.\n');
});

test('TXT exports translation items', () => {
  const output = formatTranscriptExport([sourceFinal, translationFinal], {
    format: 'txt',
    stream: 'translation'
  });

  assert.equal(output, 'Bonjour.\n');
});

test('TXT exports both streams with section headers', () => {
  const output = formatTranscriptExport([sourceFinal, translationFinal], {
    format: 'txt',
    stream: 'both'
  });

  assert.equal(output, 'Source\nHello.\n\nTranslation\nBonjour.\n');
});

test('filters whitespace-only text', () => {
  const output = formatTranscriptExport(
    [
      { ...sourceFinal, text: '   ' },
      { ...sourceFinal, id: 'source-2', text: 'Kept.', sequence: 2 }
    ],
    { format: 'txt', stream: 'source' }
  );

  assert.equal(output, 'Kept.\n');
});

test('sorts by sequence', () => {
  const output = formatTranscriptExport(
    [
      { ...sourceFinal, id: 'source-2', text: 'second', sequence: 2 },
      { ...sourceFinal, id: 'source-1', text: 'first', sequence: 1 }
    ],
    { format: 'txt', stream: 'source' }
  );

  assert.equal(output, 'first\nsecond\n');
});

test('defaults to final items only', () => {
  const output = formatTranscriptExport(
    [
      { ...sourceFinal, status: 'partial', text: 'partial', sequence: 1 },
      { ...sourceFinal, id: 'source-2', text: 'final', sequence: 2 }
    ],
    { format: 'txt', stream: 'source' }
  );

  assert.equal(output, 'final\n');
});

test('includes partials only when includePartials=true', () => {
  const items = [
    { ...sourceFinal, status: 'partial', text: 'partial', sequence: 1 },
    { ...sourceFinal, id: 'source-2', text: 'final', sequence: 2 }
  ];

  assert.equal(formatTranscriptExport(items, { format: 'txt', stream: 'source' }), 'final\n');
  assert.equal(formatTranscriptExport(items, { format: 'txt', stream: 'source', includePartials: true }), 'partial\nfinal\n');
});

test('SRT timestamp format', () => {
  const output = formatTranscriptExport([translationFinal], {
    format: 'srt',
    stream: 'translation',
    timeOrigin: 1200
  });

  assert.equal(output, '1\n00:00:01,000 --> 00:00:02,000\nBonjour.\n');
});

test('VTT timestamp format and WEBVTT header', () => {
  const output = formatTranscriptExport([translationFinal], {
    format: 'vtt',
    stream: 'translation',
    timeOrigin: 1200
  });

  assert.equal(output, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour.\n');
});

test('derives missing end time from next start', () => {
  const output = formatTranscriptExport(
    [
      { ...translationFinal, finalizedAt: undefined, startedAt: 2000, sequence: 1, text: 'one' },
      { ...translationFinal, id: 'translation-2', startedAt: 3500, finalizedAt: 4500, sequence: 2, text: 'two' }
    ],
    { format: 'srt', stream: 'translation', timeOrigin: 1000 }
  );

  assert.match(output, /00:00:01,000 --> 00:00:02,500\none/);
});

test('uses fallback duration for final cue', () => {
  const output = formatTranscriptExport(
    [{ ...translationFinal, finalizedAt: undefined, startedAt: 2000 }],
    { format: 'srt', stream: 'translation', timeOrigin: 1000, fallbackCueMs: 1500 }
  );

  assert.equal(output, '1\n00:00:01,000 --> 00:00:02,500\nBonjour.\n');
});

test('uses fallback duration when finalizedAt is not after startedAt', () => {
  const output = formatTranscriptExport(
    [{ ...translationFinal, startedAt: 2000, finalizedAt: 2000 }],
    { format: 'srt', stream: 'translation', timeOrigin: 1000, fallbackCueMs: 1500 }
  );

  assert.equal(output, '1\n00:00:01,000 --> 00:00:02,500\nBonjour.\n');
});

test('rejects missing timeOrigin for SRT/VTT', () => {
  assert.throws(
    () => formatTranscriptExport([translationFinal], { format: 'srt', stream: 'translation' }),
    /Timed transcript export requires timeOrigin/
  );
  assert.equal(canExportTranscript([translationFinal], { format: 'vtt', stream: 'translation' }), false);
});

test('rejects empty transcript', () => {
  assert.throws(() => formatTranscriptExport([], { format: 'txt', stream: 'source' }), /No exportable transcript text/);
  assert.throws(
    () => formatTranscriptExport([{ ...sourceFinal, text: ' ' }], { format: 'txt', stream: 'source' }),
    /No exportable transcript text/
  );
});

test('rejects unsupported format', () => {
  assert.throws(() => formatTranscriptExport([sourceFinal], { format: 'csv', stream: 'source' }), /Unsupported transcript export format/);
});

test('filename generation deterministic', () => {
  const now = new Date(2026, 6, 7, 8, 9, 10);

  assert.equal(buildTranscriptFileName({ format: 'vtt', now }), 'live-translate-transcript-20260707-080910.vtt');
});
