import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('audio download links use resolved persisted or local Blob URLs in both branches', () => {
  const source = fs.readFileSync(new URL('../../src/features/history/AudioArtifactDownloads.jsx', import.meta.url), 'utf8');
  assert.match(source, /href=\{inputDownloadUrl \|\| '#'/);
  assert.match(source, /href=\{translationDownloadUrl \|\| '#'/);
});
