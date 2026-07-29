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

test('TXT export preserves article mode after sorting by sequence', () => {
  const output = formatTranscriptExport(
    [
      { ...sourceFinal, id: 'source-2', text: 'second', sequence: 2 },
      { ...sourceFinal, id: 'source-1', text: 'first', sequence: 1 }
    ],
    { format: 'txt', stream: 'source' }
  );

  assert.equal(output, 'first second\n');
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
  assert.equal(formatTranscriptExport(items, { format: 'txt', stream: 'source', includePartials: true }), 'final\n');
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

test('meeting TXT export includes all segments in time order including interrupted and failed segments', () => {
  const output = formatTranscriptExport(meetingTranscriptItems(), {
    format: 'txt',
    stream: 'both'
  });

  assert.equal(
    output,
    [
      'Source',
      'segment one source',
      '',
      'segment two source',
      '',
      'segment three source',
      '',
      'Translation',
      'segment one translation',
      '',
      'segment two translation',
      '',
      'segment three translation',
      ''
    ].join('\n')
  );
});

test('meeting SRT export covers all translation segments in time order', () => {
  const output = formatTranscriptExport(meetingTranscriptItems(), {
    format: 'srt',
    stream: 'translation',
    timeOrigin: 1000
  });

  assert.equal(
    output,
    [
      '1',
      '00:00:00,000 --> 00:00:02,000',
      'segment one translation',
      '',
      '2',
      '00:01:00,000 --> 00:01:02,000',
      'segment two translation',
      '',
      '3',
      '00:02:00,000 --> 00:02:02,000',
      'segment three translation',
      ''
    ].join('\n')
  );
});

test('meeting VTT export covers all source segments in time order', () => {
  const output = formatTranscriptExport(meetingTranscriptItems(), {
    format: 'vtt',
    stream: 'source',
    timeOrigin: 1000
  });

  assert.equal(
    output,
    [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:02.000',
      'segment one source',
      '',
      '00:01:00.000 --> 00:01:02.000',
      'segment two source',
      '',
      '00:02:00.000 --> 00:02:02.000',
      'segment three source',
      ''
    ].join('\n')
  );
});

test('SRT source export merges fragments until sentence punctuation', () => {
  const output = formatTranscriptExport(
    [
      { ...sourceFinal, id: 'source-1', text: 'Hello', sequence: 1, startedAt: 2000, finalizedAt: 2400 },
      { ...sourceFinal, id: 'source-2', text: 'there.', sequence: 2, startedAt: 2450, finalizedAt: 2800 }
    ],
    { format: 'srt', stream: 'source', timeOrigin: 1000 }
  );

  assert.equal(output, '1\n00:00:01,000 --> 00:00:01,800\nHello there.\n');
});

test('SRT source export removes CJK spacing in grouped subtitle text', () => {
  const output = formatTranscriptExport(
    [
      { ...sourceFinal, id: 'source-1', text: '語音', sequence: 1, startedAt: 2000, finalizedAt: 2400 },
      { ...sourceFinal, id: 'source-2', text: '測試。', sequence: 2, startedAt: 2450, finalizedAt: 2800 }
    ],
    { format: 'srt', stream: 'source', timeOrigin: 1000 }
  );

  assert.equal(output, '1\n00:00:01,000 --> 00:00:01,800\n語音測試。\n');
});

test('VTT source export starts a new cue after a clear pause', () => {
  const output = formatTranscriptExport(
    [
      { ...sourceFinal, id: 'source-1', text: 'First part', sequence: 1, startedAt: 2000, finalizedAt: 2400 },
      { ...sourceFinal, id: 'source-2', text: 'Second', sequence: 2, startedAt: 3600, finalizedAt: 3900 },
      { ...sourceFinal, id: 'source-3', text: 'part.', sequence: 3, startedAt: 3950, finalizedAt: 4300 }
    ],
    { format: 'vtt', stream: 'source', timeOrigin: 1000 }
  );

  assert.equal(
    output,
    'WEBVTT\n\n00:00:01.000 --> 00:00:01.400\nFirst part\n\n00:00:02.600 --> 00:00:03.300\nSecond part.\n'
  );
});

test('SRT translation export aligns a single large translation item to source cue windows', () => {
  const output = formatTranscriptExport(
    [
      { ...sourceFinal, id: 'source-1', text: '其實，', sequence: 1, startedAt: 1000, finalizedAt: 2000 },
      { ...sourceFinal, id: 'source-2', text: '語音測試。', sequence: 2, startedAt: 3300, finalizedAt: 4300 },
      {
        ...translationFinal,
        id: 'translation-1',
        text: 'Actually, Voice test.',
        sequence: 3,
        startedAt: 1000,
        finalizedAt: 4300
      }
    ],
    { format: 'srt', stream: 'translation', timeOrigin: 1000 }
  );

  assert.equal(
    output,
    '1\n00:00:00,000 --> 00:00:01,000\nActually,\n\n2\n00:00:02,300 --> 00:00:03,300\nVoice test.\n'
  );
});

test('SRT translation export keeps repeated phrases together when aligning to source cues', () => {
  const output = formatTranscriptExport(
    [
      { ...sourceFinal, id: 'source-1', text: '其實，', sequence: 1, startedAt: 6180, finalizedAt: 9031 },
      { ...sourceFinal, id: 'source-2', text: '語音測試。', sequence: 2, startedAt: 13018, finalizedAt: 17447 },
      { ...sourceFinal, id: 'source-3', text: '123,123,', sequence: 3, startedAt: 20142, finalizedAt: 23149 },
      { ...sourceFinal, id: 'source-4', text: '愛克風測試。', sequence: 4, startedAt: 26291, finalizedAt: 28088 },
      { ...sourceFinal, id: 'source-5', text: '愛克風測試。', sequence: 5, startedAt: 28088, finalizedAt: 32516 },
      {
        ...translationFinal,
        id: 'translation-1',
        text: 'Actually, actually, Voice test. 123, 123, Alan speak test. Alan speak test.',
        sequence: 6,
        startedAt: 6180,
        finalizedAt: 32516
      }
    ],
    { format: 'srt', stream: 'translation', timeOrigin: 1000 }
  );

  assert.equal(
    output,
    [
      '1',
      '00:00:05,180 --> 00:00:08,031',
      'Actually, actually,',
      '',
      '2',
      '00:00:12,018 --> 00:00:16,447',
      'Voice test.',
      '',
      '3',
      '00:00:19,142 --> 00:00:22,149',
      '123, 123,',
      '',
      '4',
      '00:00:25,291 --> 00:00:27,088',
      'Alan speak test.',
      '',
      '5',
      '00:00:27,088 --> 00:00:31,516',
      'Alan speak test.',
      ''
    ].join('\n')
  );
});

test('VTT translation export keeps phrases together when aligning to source cues', () => {
  const output = formatTranscriptExport(
    [
      { ...sourceFinal, id: 'source-1', text: '其實，', sequence: 1, startedAt: 6180, finalizedAt: 9031 },
      { ...sourceFinal, id: 'source-2', text: '語音測試。', sequence: 2, startedAt: 13018, finalizedAt: 17447 },
      { ...sourceFinal, id: 'source-3', text: '123,123,', sequence: 3, startedAt: 20142, finalizedAt: 23149 },
      { ...sourceFinal, id: 'source-4', text: '愛克風測試。', sequence: 4, startedAt: 26291, finalizedAt: 28088 },
      { ...sourceFinal, id: 'source-5', text: '愛克風測試。', sequence: 5, startedAt: 28088, finalizedAt: 32516 },
      {
        ...translationFinal,
        id: 'translation-1',
        text: 'Actually, actually, Voice test. 123, 123, Alan speak test. Alan speak test.',
        sequence: 6,
        startedAt: 6180,
        finalizedAt: 32516
      }
    ],
    { format: 'vtt', stream: 'translation', timeOrigin: 1000 }
  );

  assert.equal(
    output,
    [
      'WEBVTT',
      '',
      '00:00:05.180 --> 00:00:08.031',
      'Actually, actually,',
      '',
      '00:00:12.018 --> 00:00:16.447',
      'Voice test.',
      '',
      '00:00:19.142 --> 00:00:22.149',
      '123, 123,',
      '',
      '00:00:25.291 --> 00:00:27.088',
      'Alan speak test.',
      '',
      '00:00:27.088 --> 00:00:31.516',
      'Alan speak test.',
      ''
    ].join('\n')
  );
});

test('VTT translation export uses source cue windows', () => {
  const output = formatTranscriptExport(
    [
      { ...sourceFinal, id: 'source-1', text: '其實，', sequence: 1, startedAt: 1000, finalizedAt: 2000 },
      { ...sourceFinal, id: 'source-2', text: '語音測試。', sequence: 2, startedAt: 3300, finalizedAt: 4300 },
      {
        ...translationFinal,
        id: 'translation-1',
        text: 'Actually, Voice test.',
        sequence: 3,
        startedAt: 1000,
        finalizedAt: 4300
      }
    ],
    { format: 'vtt', stream: 'translation', timeOrigin: 1000 }
  );

  assert.equal(
    output,
    'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nActually,\n\n00:00:02.300 --> 00:00:03.300\nVoice test.\n'
  );
});

test('SRT translation export removes CJK spacing when aligned to source cues', () => {
  const output = formatTranscriptExport(
    [
      { ...sourceFinal, id: 'source-1', text: '語音測試。', sequence: 1, startedAt: 2000, finalizedAt: 2800 },
      {
        ...translationFinal,
        id: 'translation-1',
        text: '愛克 風 測試。',
        sequence: 2,
        startedAt: 2000,
        finalizedAt: 2800
      }
    ],
    { format: 'srt', stream: 'translation', timeOrigin: 1000 }
  );

  assert.equal(output, '1\n00:00:01,000 --> 00:00:01,800\n愛克風測試。\n');
});

test('SRT translation export remains item-based when source cues are unavailable', () => {
  const output = formatTranscriptExport(
    [
      { ...translationFinal, id: 'translation-1', text: 'one', sequence: 1, startedAt: 2000, finalizedAt: 2400 },
      { ...translationFinal, id: 'translation-2', text: 'two.', sequence: 2, startedAt: 2450, finalizedAt: 2800 }
    ],
    { format: 'srt', stream: 'translation', timeOrigin: 1000 }
  );

  assert.equal(
    output,
    '1\n00:00:01,000 --> 00:00:01,400\none\n\n2\n00:00:01,450 --> 00:00:01,800\ntwo.\n'
  );
});

test('SRT translation export falls back to length splitting without useful punctuation', () => {
  const output = formatTranscriptExport(
    [
      { ...sourceFinal, id: 'source-1', text: '一', sequence: 1, startedAt: 2000, finalizedAt: 2400 },
      { ...sourceFinal, id: 'source-2', text: '二', sequence: 2, startedAt: 3600, finalizedAt: 3900 },
      {
        ...translationFinal,
        id: 'translation-1',
        text: 'alpha beta gamma delta',
        sequence: 3,
        startedAt: 2000,
        finalizedAt: 3900
      }
    ],
    { format: 'srt', stream: 'translation', timeOrigin: 1000 }
  );

  assert.equal(
    output,
    '1\n00:00:01,000 --> 00:00:01,400\nalpha beta\n\n2\n00:00:02,600 --> 00:00:02,900\ngamma delta\n'
  );
});

test('SRT source grouped cue uses fallback when final group has no valid end time', () => {
  const output = formatTranscriptExport(
    [
      { ...sourceFinal, id: 'source-1', text: 'Hello', sequence: 1, startedAt: 2000, finalizedAt: 2400 },
      { ...sourceFinal, id: 'source-2', text: 'there.', sequence: 2, startedAt: 2450, finalizedAt: undefined }
    ],
    { format: 'srt', stream: 'source', timeOrigin: 1000, fallbackCueMs: 1500 }
  );

  assert.equal(output, '1\n00:00:01,000 --> 00:00:02,500\nHello there.\n');
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

function meetingTranscriptItems() {
  return [
    meetingItem({ id: 'source-1', segmentId: 'segment-1', segmentSequence: 0, segmentStatus: 'completed', stream: 'source', sequence: 1, text: 'segment one source', startedAt: 1000, finalizedAt: 3000 }),
    meetingItem({ id: 'translation-1', segmentId: 'segment-1', segmentSequence: 0, segmentStatus: 'completed', stream: 'translation', sequence: 2, text: 'segment one translation', startedAt: 1000, finalizedAt: 3000 }),
    meetingItem({ id: 'source-2', segmentId: 'segment-2', segmentSequence: 1, segmentStatus: 'interrupted', stream: 'source', sequence: 3, text: 'segment two source', startedAt: 61000, finalizedAt: 63000 }),
    meetingItem({ id: 'translation-2', segmentId: 'segment-2', segmentSequence: 1, segmentStatus: 'interrupted', stream: 'translation', sequence: 4, text: 'segment two translation', startedAt: 61000, finalizedAt: 63000 }),
    meetingItem({ id: 'source-3', segmentId: 'segment-3', segmentSequence: 2, segmentStatus: 'failed', stream: 'source', sequence: 5, text: 'segment three source', startedAt: 121000, finalizedAt: 123000 }),
    meetingItem({ id: 'translation-3', segmentId: 'segment-3', segmentSequence: 2, segmentStatus: 'failed', stream: 'translation', sequence: 6, text: 'segment three translation', startedAt: 121000, finalizedAt: 123000 })
  ];
}

function meetingItem(overrides) {
  return {
    meetingId: 'meeting-1',
    liveSessionId: `live-${overrides.segmentSequence + 1}`,
    status: 'final',
    ...overrides
  };
}
