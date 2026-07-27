import assert from 'node:assert/strict';
import test from 'node:test';
import { toTraditionalChineseSourceContent, toTraditionalChineseText } from '../../src/lib/chineseText.js';

test('converts simplified Chinese text to Taiwan traditional Chinese', () => {
  assert.equal(toTraditionalChineseText('汉语 软件 自行车'), '漢語 軟體 腳踏車');
});

test('preserves non-string or empty values', () => {
  assert.equal(toTraditionalChineseText(''), '');
  assert.equal(toTraditionalChineseText(null), null);
});

test('converts source content text and paragraphs while preserving metadata', () => {
  assert.deepEqual(
    toTraditionalChineseSourceContent({
      kind: 'sourceTranscript',
      status: 'available',
      text: '汉语 软件',
      paragraphs: ['自行车', 'OpenAI'],
      createdAt: 1
    }),
    {
      kind: 'sourceTranscript',
      status: 'available',
      text: '漢語 軟體',
      paragraphs: ['腳踏車', 'OpenAI'],
      createdAt: 1
    }
  );
});
