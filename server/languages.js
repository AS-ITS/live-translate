export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: '英文' },
  { code: 'ja', label: '日文' },
  { code: 'ko', label: '韓文' },
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'zh-Hans', label: '簡體中文' },
  { code: 'es', label: '西班牙文' },
  { code: 'fr', label: '法文' },
  { code: 'de', label: '德文' }
];

export function isSupportedLanguage(code) {
  return SUPPORTED_LANGUAGES.some((language) => language.code === code);
}
