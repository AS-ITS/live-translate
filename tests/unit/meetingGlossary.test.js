import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveMeetingGlossaryEntries, meetingGlossaryAliasesForTarget, mergeMeetingGlossaryEntries, selectedMeetingGlossaryEntries } from '../../src/lib/meetingGlossary.js';

test('effective meeting dictionary includes every global entry and meeting overrides by source', () => {
  assert.deepEqual(
    effectiveMeetingGlossaryEntries(
      [
        { id: 'global-selected', source: 'alpha', scope: 'live', translations: { en: 'Alpha global' } },
        { id: 'global-unselected', source: 'beta', scope: 'live', translations: { en: 'Beta global' } }
      ],
      [{ source: 'alpha', translations: { en: 'Alpha meeting' } }],
      'en'
    ),
    [
      { id: 'global-selected', source: 'alpha', target: 'Alpha meeting', replacementAliases: ['Alpha global'] },
      { id: 'global-unselected', source: 'beta', target: 'Beta global', replacementAliases: [] }
    ]
  );
});

test('effective meeting dictionary keeps selected global entries as meeting overrides', () => {
  const globalEntries = [
    { id: 'selected', source: 'alpha', scope: 'live', translations: { en: 'Alpha global' } },
    { id: 'unselected', source: 'beta', scope: 'live', translations: { en: 'Beta global' } }
  ];
  const selected = selectedMeetingGlossaryEntries(globalEntries, ['selected'], 'en');
  assert.deepEqual(
    mergeMeetingGlossaryEntries(
      liveEntriesForTest(globalEntries, 'en'),
      [...selected, { source: 'alpha', translations: { en: 'Alpha meeting' } }],
      'en'
    ),
    [
      { id: 'selected', source: 'alpha', target: 'Alpha meeting', replacementAliases: ['Alpha global'] },
      { id: 'unselected', source: 'beta', target: 'Beta global', replacementAliases: [] }
    ]
  );
});

function liveEntriesForTest(entries, targetLanguageCode) {
  return entries.map((entry) => ({
    id: entry.id,
    source: entry.source,
    target: entry.translations[targetLanguageCode],
    replacementAliases: []
  }));
}

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
