import { promises as defaultFileSystem } from 'node:fs';
import { isSupportedLanguage } from '../../server/languages.js';

export function createTranslationGlossary({ filePath, fileSystem = defaultFileSystem } = {}) {
  assertOptionalFilePath(filePath);
  assertFileSystem(fileSystem);

  let entriesPromise;

  return Object.freeze({
    async entriesFor(targetLanguageCode) {
      assertSupportedTargetLanguageCode(targetLanguageCode);
      const entries = await loadEntries();
      return Object.freeze(
        entries
          .filter((entry) => Object.hasOwn(entry.translations, targetLanguageCode))
          .map((entry) => Object.freeze({ source: entry.source, target: entry.translations[targetLanguageCode] }))
      );
    }
  });

  function loadEntries() {
    if (entriesPromise === undefined) {
      entriesPromise = filePath === undefined ? Promise.resolve(Object.freeze([])) : readEntries(fileSystem, filePath);
    }
    return entriesPromise;
  }
}

async function readEntries(fileSystem, filePath) {
  let content;
  try {
    content = await fileSystem.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze([]);
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new TypeError('Translation glossary JSON is invalid.');
  }

  return Object.freeze(validateGlossary(parsed));
}

function validateGlossary(value) {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new TypeError('Translation glossary must contain an entries array.');
  }

  return value.entries.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`Translation glossary entry ${index} must be an object.`);
    assertNonBlankString(entry.source, `Translation glossary entry ${index}.source`);
    if (!isRecord(entry.translations)) {
      throw new TypeError(`Translation glossary entry ${index}.translations must be an object.`);
    }

    const translations = Object.entries(entry.translations);
    if (translations.length === 0) {
      throw new TypeError(`Translation glossary entry ${index}.translations must not be empty.`);
    }
    for (const [languageCode, translation] of translations) {
      if (!isSupportedLanguage(languageCode)) {
        throw new RangeError(`Translation glossary entry ${index} has unsupported target language: ${languageCode}`);
      }
      assertNonBlankString(translation, `Translation glossary entry ${index}.translations.${languageCode}`);
    }

    return Object.freeze({ source: entry.source, translations: Object.freeze({ ...entry.translations }) });
  });
}

function assertSupportedTargetLanguageCode(value) {
  assertNonBlankString(value, 'targetLanguageCode');
  if (!isSupportedLanguage(value)) throw new RangeError(`Unsupported targetLanguageCode: ${value}`);
}

function assertOptionalFilePath(value) {
  if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
    throw new TypeError('TRANSLATION_GLOSSARY_FILE must be a non-empty string when provided.');
  }
}

function assertFileSystem(value) {
  if (!value || typeof value.readFile !== 'function') throw new TypeError('fileSystem.readFile must be a function.');
}

function assertNonBlankString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string.`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
