import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('HTML declares the fixed default SVG favicon with ICO fallback', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /<link rel="icon" type="image\/x-icon" href="%BASE_URL%favicon\.ico"\s*\/>/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="%BASE_URL%favicon\.svg"\s*\/>/);
  assert.doesNotMatch(html, /favicon-recording|app-favicon/);
  for (const name of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) {
    assert.ok(readFileSync(new URL(`../../public/${name}`, import.meta.url)).length > 0, `${name} exists`);
  }
});
