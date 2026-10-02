import assert from 'node:assert/strict';
import test from 'node:test';
import { meetingGlossaryAliasesForTarget, mergeMeetingGlossaryEntries, selectedMeetingGlossaryEntries } from '../../src/lib/meetingGlossary.js';

test('meeting glossary aliases normalize arrays and target-language maps', () => {
  assert.deepEqual(meetingGlossaryAliasesForTarget([' mic ', '', 42], 'en'), [' mic ']);
  assert.deepEqual(meetingGlossaryAliasesForTarget({ en: ['mic'], ja: ['マイク'] }, 'en'), ['mic']);
  assert.deepEqual(meetingGlossaryAliasesForTarget({ en: ['mic'] }, 'fr'), []);
  assert.deepEqual(meetingGlossaryAliasesForTarget('legacy', 'en'), []);
  assert.deepEqual(meetingGlossaryAliasesForTarget(null, 'en'), []);
});

test('selected meeting glossary entries ignore non-array and invalid aliases', () => {
  assert.deepEqual(
    selectedMeetingGlossaryEntries([
      {
        id: 'legacy-entry',
        source: 'microphone',
        translations: { en: 'Mic' },
        replacementAliases: { en: {}, ja: [' mic ', '', 42] }
      }
    ], ['legacy-entry'], 'en'),
    [{
      source: 'microphone',
      translations: { en: 'Mic' },
      replacementAliases: { en: [], ja: [' mic '] }
    }]
  );

  assert.deepEqual(
    selectedMeetingGlossaryEntries([
      { id: 'null-entry', source: 'null', translations: {}, replacementAliases: null },
      { id: 'string-entry', source: 'string', translations: {}, replacementAliases: 'legacy' }
    ], ['null-entry', 'string-entry'], 'en'),
    [
      { source: 'null', translations: {}, replacementAliases: {} },
      { source: 'string', translations: {}, replacementAliases: {} }
    ]
  );
});

test('meeting glossary overrides same-source shared entry and retains correction aliases', () => {
  assert.deepEqual(mergeMeetingGlossaryEntries(
    [{ source: '你好', target: 'Hi', replacementAliases: ['Hello'] }],
    [{ source: '你好', translations: { en: 'speak Hi' }, replacementAliases: { en: [] } }],
    'en'
  ), [{ source: '你好', target: 'speak Hi', replacementAliases: ['Hi', 'Hello'] }]);
});
