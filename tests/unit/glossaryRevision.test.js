import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  EFFECTIVE_GLOSSARY_REVISION_CONTRACT,
  canonicalEffectiveGlossary,
  effectiveGlossaryRevision,
  serializeEffectiveGlossary
} from '../../src/lib/glossaryRevision.js';

test('effective glossary revision is deterministic across entry and alias ordering', async () => {
  const first = {
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en',
    entries: [
      { source: 'B', target: 'Beta', replacementAliases: ['b2', 'b1'] },
      { source: 'Ａ', target: 'Alpha', replacementAliases: [' a ', 'a'] }
    ]
  };
  const reordered = {
    ...first,
    entries: [
      { source: 'A', target: 'Alpha', replacementAliases: ['a'] },
      { source: 'B', target: 'Beta', replacementAliases: ['b1', 'b2'] }
    ]
  };

  assert.deepEqual(canonicalEffectiveGlossary(first), canonicalEffectiveGlossary(reordered));
  assert.equal(await effectiveGlossaryRevision(first), await effectiveGlossaryRevision(reordered));
});

test('browser and server SHA-256 use the same versioned canonical payload', async () => {
  const input = {
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en',
    entries: [{ source: '你好', target: 'su3cl3', replacementAliases: ['Hello'] }]
  };
  const serialized = serializeEffectiveGlossary(input);
  const serverRevision = createHash('sha256').update(serialized).digest('hex');

  assert.match(serialized, new RegExp(EFFECTIVE_GLOSSARY_REVISION_CONTRACT));
  assert.equal(await effectiveGlossaryRevision(input), serverRevision);
});

test('revision changes for source, target, alias, or language changes', async () => {
  const base = {
    sourceLanguageCode: 'zh-Hant',
    targetLanguageCode: 'en',
    entries: [{ source: '你好', target: 'Hello', replacementAliases: ['Hi'] }]
  };
  const revision = await effectiveGlossaryRevision(base);
  const variants = [
    { ...base, sourceLanguageCode: 'ja' },
    { ...base, targetLanguageCode: 'fr' },
    { ...base, entries: [{ ...base.entries[0], source: '您好' }] },
    { ...base, entries: [{ ...base.entries[0], target: 'Hi' }] },
    { ...base, entries: [{ ...base.entries[0], replacementAliases: ['Hey'] }] }
  ];

  for (const variant of variants) {
    assert.notEqual(await effectiveGlossaryRevision(variant), revision);
  }
});
