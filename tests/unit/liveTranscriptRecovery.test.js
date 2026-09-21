import assert from 'node:assert/strict';
import test from 'node:test';
import { transcriptItemCoveredByCue, transcriptTextForDisplay, unrepresentedTranscriptItems } from '../../src/features/live/liveTranscriptRecovery.js';

const cue = {
  cueId: 'cue-1',
  status: 'final',
  sessionId: 'session-1',
  segmentId: 'segment-1',
  sourceText: '你好，你好。',
  translatedText: ''
};

test('live transcript item without legacy segment metadata is covered by matching Cue text', () => {
  assert.equal(transcriptItemCoveredByCue({ stream: 'source', text: '你好，你好。' }, cue), true);
  assert.deepEqual(unrepresentedTranscriptItems({
    transcript: { source: { finalItems: [{ id: 'source-1', stream: 'source', status: 'final', text: '你好，你好。' }] } },
    cues: [cue]
  }), []);
});

test('transcript items from another session remain available as fallback', () => {
  assert.equal(transcriptItemCoveredByCue({ sessionId: 'session-2', stream: 'source', text: '你好，你好。' }, cue), false);
});

test('a current partial Cue covers the finalized legacy transcript snapshot', () => {
  const currentCue = {
    ...cue,
    cueId: 'cue-current',
    status: 'partial',
    sourceText: '你好，你好，我是錄音測試員1234567。'
  };
  const item = {
    id: 'source-1',
    stream: 'source',
    status: 'final',
    sessionId: 'session-1',
    segmentId: 'segment-1',
    text: '你好，你好，我是錄音測試員'
  };

  assert.equal(transcriptItemCoveredByCue(item, currentCue), true);
  assert.deepEqual(unrepresentedTranscriptItems({
    transcript: { source: { finalItems: [item] } },
    cues: [currentCue]
  }), []);
});

test('archived and active copies of the same transcript item are returned once', () => {
  const item = {
    id: 'source-duplicate',
    stream: 'source',
    status: 'final',
    text: '尚未整理的逐字稿',
    sequence: 1
  };

  assert.deepEqual(unrepresentedTranscriptItems({
    archivedTranscript: { source: { finalItems: [item] } },
    transcript: { source: { finalItems: [item] } }
  }), [item]);
});

test('source display preserves Simplified Chinese only when explicitly selected', () => {
  assert.equal(transcriptTextForDisplay({ stream: 'source', text: '测试文字', sourceLanguageCode: 'zh-Hant' }), '測試文字');
  assert.equal(transcriptTextForDisplay({ stream: 'source', text: '测试文字', sourceLanguageCode: 'zh-Hans' }), '测试文字');
  assert.equal(transcriptTextForDisplay({ stream: 'source', text: 'Hello' }), 'Hello');
});

test('scope mismatch is rejected when both transcript and Cue identify different segments', () => {
  assert.equal(transcriptItemCoveredByCue({ sessionId: 'session-1', segmentId: 'segment-2', stream: 'source', text: '你好，你好。' }, cue), false);
});

test('matching audio turn covers legacy text even when provider formatting differs', () => {
  assert.equal(transcriptItemCoveredByCue({
    sessionId: 'session-1',
    segmentId: 'segment-1',
    stream: 'source',
    audioTurnId: 'audio-turn-1',
    text: '測試 1 2 3'
  }, {
    ...cue,
    audioTurnId: 'audio-turn-1',
    sourceText: '測試一二三'
  }), true);
});

test('different audio turns remain separate even when their text is identical', () => {
  const item = {
    id: 'source-turn-2',
    sessionId: 'session-1',
    segmentId: 'segment-1',
    stream: 'source',
    audioTurnId: 'audio-turn-2',
    status: 'final',
    sequence: 2,
    text: '相同內容'
  };
  assert.equal(transcriptItemCoveredByCue(item, {
    ...cue,
    audioTurnId: 'audio-turn-1',
    sourceText: '相同內容'
  }), false);
  assert.deepEqual(unrepresentedTranscriptItems({
    transcript: { source: { finalItems: [item] } },
    cues: [{ ...cue, audioTurnId: 'audio-turn-1', sourceText: '相同內容' }]
  }), [item]);
});

test('source and translation streams do not cover one another by turn identity', () => {
  const sourceItem = { stream: 'source', audioTurnId: 'audio-turn-1', text: '相同內容' };
  const translationCue = { ...cue, stream: 'translation', audioTurnId: 'audio-turn-1', translatedText: '相同內容' };
  assert.equal(transcriptItemCoveredByCue(sourceItem, translationCue), false);
});

test('missing audio turn identity keeps normalized text fallback', () => {
  assert.equal(transcriptItemCoveredByCue({ stream: 'source', text: '測試 1 2 3' }, {
    ...cue,
    sourceText: '測試123'
  }), true);
});

test('unrepresented transcript fallback merges adjacent numeric fragments and hides no content', () => {
  const items = unrepresentedTranscriptItems({
    transcript: {
      source: {
        finalItems: [
          { id: 'source-1', stream: 'source', status: 'final', sequence: 1, text: '測試測試' },
          { id: 'source-2', stream: 'source', status: 'final', sequence: 2, text: '123' },
          { id: 'source-3', stream: 'source', status: 'final', sequence: 3, text: '3' }
        ]
      }
    },
    cues: []
  });

  assert.deepEqual(items.map((item) => item.text), ['測試測試123']);
});

test('matching text does not cover an item from a different scope', () => {
  assert.equal(transcriptItemCoveredByCue({
    sessionId: 'session-2',
    segmentId: 'segment-1',
    stream: 'source',
    audioTurnId: 'audio-turn-1',
    text: '相同內容'
  }, {
    ...cue,
    audioTurnId: 'audio-turn-1',
    sourceText: '相同內容'
  }), false);
});
