import { promises as defaultFileSystem } from 'node:fs';
import { dirname } from 'node:path';
import { isSupportedLanguage } from '../../server/languages.js';

const GLOSSARY_SCOPES = new Set(['live', 'history', 'both']);

export function createTranslationGlossary({ filePath, fileSystem = defaultFileSystem, idFactory = defaultIdFactory, clock = () => Date.now() } = {}) {
  assertOptionalFilePath(filePath);
  assertFileSystem(fileSystem);

  let entriesPromise;

  return Object.freeze({
    async entriesFor(targetLanguageCode, options = {}) {
      assertSupportedTargetLanguageCode(targetLanguageCode);
      const scope = normalizeOptionalScope(options.scope);
      const entries = await loadEntries();
      return Object.freeze(
        entries
          .filter((entry) => Object.hasOwn(entry.translations, targetLanguageCode))
          .filter((entry) => scope === undefined || entry.scope === scope || entry.scope === 'both')
          .map((entry) => Object.freeze({
            source: entry.source,
            target: entry.translations[targetLanguageCode],
            replacementAliases: Object.freeze([...(entry.replacementAliases[targetLanguageCode] || [])])
          }))
      );
    },

    async listEntries() {
      return (await loadEntries()).map(cloneEntry);
    },

    async createEntry(input = {}) {
      assertConfigured(filePath);
      assertWritableFileSystem(fileSystem);
      const storage = await readStorage(fileSystem, filePath);
      const entry = normalizeMutableEntry({ ...input, id: input.id ?? idFactory(), createdAt: clock(), updatedAt: clock() }, storage.entries.length);
      if (storage.entries.some((candidate) => candidate.id === entry.id)) {
        const error = new Error(`Translation glossary entry already exists: ${entry.id}`);
        error.code = 'invalid_request';
        throw error;
      }

      storage.entries.push(entry);
      await writeStorage(fileSystem, filePath, storage);
      entriesPromise = Promise.resolve(Object.freeze(storage.entries.map(cloneEntry)));
      return cloneEntry(entry);
    },

    async updateEntry(id, input = {}) {
      assertConfigured(filePath);
      assertWritableFileSystem(fileSystem);
      assertNonBlankString(id, 'id');
      const storage = await readStorage(fileSystem, filePath);
      const index = storage.entries.findIndex((entry) => entry.id === id);
      if (index === -1) {
        const error = new Error(`Translation glossary entry not found: ${id}`);
        error.code = 'glossary_entry_not_found';
        throw error;
      }

      const entry = normalizeMutableEntry({
        ...storage.entries[index],
        ...input,
        id,
        createdAt: storage.entries[index].createdAt,
        updatedAt: clock()
      }, index);
      storage.entries[index] = entry;
      await writeStorage(fileSystem, filePath, storage);
      entriesPromise = Promise.resolve(Object.freeze(storage.entries.map(cloneEntry)));
      return cloneEntry(entry);
    },

    async deleteEntry(id) {
      assertConfigured(filePath);
      assertWritableFileSystem(fileSystem);
      assertNonBlankString(id, 'id');
      const storage = await readStorage(fileSystem, filePath);
      const index = storage.entries.findIndex((entry) => entry.id === id);
      if (index === -1) {
        const error = new Error(`Translation glossary entry not found: ${id}`);
        error.code = 'glossary_entry_not_found';
        throw error;
      }

      const [entry] = storage.entries.splice(index, 1);
      await writeStorage(fileSystem, filePath, storage);
      entriesPromise = Promise.resolve(Object.freeze(storage.entries.map(cloneEntry)));
      return cloneEntry(entry);
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
  return Object.freeze((await readStorage(fileSystem, filePath)).entries.map(cloneEntry));
}

async function readStorage(fileSystem, filePath) {
  let content;
  try {
    content = await fileSystem.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: [] };
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new TypeError('Translation glossary JSON is invalid.');
  }

  return { entries: validateGlossary(parsed) };
}

async function writeStorage(fileSystem, filePath, storage) {
  const value = { entries: validateGlossary(storage) };
  await fileSystem.mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await fileSystem.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fileSystem.rename(temporaryPath, filePath);
}

function validateGlossary(value) {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new TypeError('Translation glossary must contain an entries array.');
  }

  return value.entries.map((entry, index) => {
    return normalizeMutableEntry(entry, index);
  });
}

function normalizeMutableEntry(entry, index) {
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
  const replacementAliases = normalizeReplacementAliases(entry.replacementAliases, index);

  return Object.freeze({
    id: entry.id === undefined ? legacyEntryId(index) : assertNonBlankString(entry.id, `Translation glossary entry ${index}.id`),
    source: entry.source,
    translations: Object.freeze({ ...entry.translations }),
    replacementAliases,
    scope: normalizeEntryScope(entry.scope, index),
    ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
    ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt })
  });
}

function normalizeReplacementAliases(value, index) {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) {
    throw new TypeError(`Translation glossary entry ${index}.replacementAliases must be an object.`);
  }

  const normalized = {};
  for (const [languageCode, aliases] of Object.entries(value)) {
    if (!isSupportedLanguage(languageCode)) {
      throw new RangeError(`Translation glossary entry ${index} has unsupported replacement alias language: ${languageCode}`);
    }
    if (!Array.isArray(aliases)) {
      throw new TypeError(`Translation glossary entry ${index}.replacementAliases.${languageCode} must be an array.`);
    }
    normalized[languageCode] = Object.freeze(aliases.map((alias, aliasIndex) => {
      return assertNonBlankString(alias, `Translation glossary entry ${index}.replacementAliases.${languageCode}.${aliasIndex}`);
    }));
  }
  return Object.freeze(normalized);
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
  return value;
}

function normalizeEntryScope(value, index) {
  if (value === undefined) return 'history';
  if (!GLOSSARY_SCOPES.has(value)) {
    throw new RangeError(`Translation glossary entry ${index}.scope must be live, history, or both.`);
  }
  return value;
}

function normalizeOptionalScope(value) {
  if (value === undefined) return undefined;
  if (!GLOSSARY_SCOPES.has(value)) {
    throw new RangeError('scope must be live, history, or both.');
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertConfigured(filePath) {
  if (filePath === undefined) {
    const error = new Error('TRANSLATION_GLOSSARY_FILE is not configured.');
    error.code = 'glossary_not_configured';
    throw error;
  }
}

function assertWritableFileSystem(fileSystem) {
  for (const method of ['mkdir', 'writeFile', 'rename']) {
    if (typeof fileSystem[method] !== 'function') throw new TypeError(`fileSystem.${method} must be a function.`);
  }
}

function cloneEntry(entry) {
  return JSON.parse(JSON.stringify(entry));
}

function defaultIdFactory() {
  return `glossary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function legacyEntryId(index) {
  return `entry-${index}`;
}
