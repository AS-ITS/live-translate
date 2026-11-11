export function hasSmokeGeminiKey(value) {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  if (!key || /[\s\x00-\x1F\x7F]/u.test(key)) return false;
  const placeholder = key.toLowerCase().replace(/[^a-z]/gu, '');
  return !/^(?:test|dummy|fake|example|placeholder|changeme|replaceme|your(?:gemini)?apikey|yourkey)$/u.test(placeholder);
}
