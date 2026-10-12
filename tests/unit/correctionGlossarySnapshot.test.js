import assert from 'node:assert/strict';
import test from 'node:test';
import { createCorrectionGlossaryRegistry } from '../../src/lib/correctionGlossarySnapshot.js';

test('new turns use latest correction glossary while existing turns keep their revision', () => {
  const registry = createCorrectionGlossaryRegistry();
  const revisionA = registry.activate({
    revision: 'revision-a',
    entries: [{ source: '你好', target: 'A', replacementAliases: [] }]
  });
  const firstPartial = registry.bindTurn({ turnKey: 'turn-1' }, 1);

  const revisionB = registry.activate({
    revision: 'revision-b',
    entries: [{ source: '你好', target: 'B', replacementAliases: [] }]
  });
  const firstLateFinal = registry.bindTurn({ turnKey: 'turn-1' }, 1);
  const secondTurn = registry.bindTurn({ turnKey: 'turn-2' }, 1);

  assert.equal(firstPartial, revisionA);
  assert.equal(firstLateFinal, revisionA);
  assert.equal(secondTurn, revisionB);
  assert.equal(registry.entriesForRevision('revision-a')[0].target, 'A');
  assert.equal(registry.entriesForRevision('revision-b')[0].target, 'B');
});

test('missing stable turn identity uses active snapshot without guessing a persistent binding', () => {
  const registry = createCorrectionGlossaryRegistry();
  registry.activate({ revision: 'revision-a', entries: [] });
  assert.equal(registry.bindTurn({}, 1).revision, 'revision-a');
  registry.activate({ revision: 'revision-b', entries: [] });
  assert.equal(registry.bindTurn({}, 1).revision, 'revision-b');
  assert.equal(registry.turnBindingCount(), 0);
});
