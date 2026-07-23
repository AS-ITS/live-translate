import assert from 'node:assert/strict';
import test from 'node:test';
import { applyGlossaryReplacements } from '../../src/lib/glossaryReplacement.js';

test('glossary replacement handles source terms, legacy aliases, repeated matches, and longest-first ordering', () => {
  const entries = [
    { source: 'microphone', target: 'Alan speak', replacementAliases: ['mic'] },
    { source: 'mic stand', target: 'Alan speak stand', replacementAliases: [] }
  ];

  assert.equal(
    applyGlossaryReplacements('microphone and mic near mic stand. microphone works.', entries),
    'Alan speak and Alan speak near Alan speak stand. Alan speak works.'
  );
});

test('glossary replacement supports source-only entries from the simplified UI', () => {
  assert.equal(
    applyGlossaryReplacements('microphone check', [{ source: 'microphone', target: 'Alan speak' }]),
    'Alan speak check'
  );
});

test('glossary replacement treats candidates as literal strings', () => {
  assert.equal(
    applyGlossaryReplacements('a.b aXb', [{ source: 'a.b', target: 'term', replacementAliases: [] }]),
    'term aXb'
  );
});
