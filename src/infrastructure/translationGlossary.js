import { promises as defaultFileSystem } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { isSupportedLanguage } from '../../server/languages.js';

const GLOSSARY_SCOPES = new Set(['live', 'history', 'both']);
const DEFAULT_CATEGORIES = [
  { id: 'product', label: '產品名稱', sortOrder: 0, system: false },
  { id: 'department', label: '部門／職能', sortOrder: 1, system: false },
  { id: 'abbreviation', label: '縮寫', sortOrder: 2, system: false },
  { id: 'meeting', label: '會議常用語', sortOrder: 3, system: false },
  { id: 'technical', label: '技術名詞', sortOrder: 4, system: false },
  { id: 'other', label: '其他', sortOrder: 5, system: false }
];

export function createTranslationGlossary({ filePath, fileSystem = defaultFileSystem, idFactory = defaultIdFactory, clock = () => Date.now() } = {}) {
  assertOptionalFilePath(filePath);
  assertFileSystem(fileSystem);

  let entriesPromise;
  let storagePromise;

  return Object.freeze({
    async previewImport({ format, content, sourceLanguageCode, targetLanguageCode, category } = {}) {
      const storage = await loadStorage();
      return await buildImportPreview(storage, format, content, { sourceLanguageCode, targetLanguageCode, category });
    },

    async importEntries({ format, content, sourceLanguageCode, targetLanguageCode, category, baseRevision, resolutions = {}, selectedRows } = {}) {
      assertConfigured(filePath);
      assertWritableFileSystem(fileSystem);
      const storage = await readStorage(fileSystem, filePath);
      const currentRevision = glossaryRevision(storage);
      if (baseRevision !== currentRevision) throw glossaryError('glossary_revision_conflict', 'Glossary changed after the import preview.');
      const preview = await buildImportPreview(storage, format, content, { sourceLanguageCode, targetLanguageCode, category });
      const rowsToImport = selectedRows === undefined
        ? preview.rows
        : preview.rows.filter((row) => selectedRows.includes(row.rowNumber));
      if (rowsToImport.some((row) => row.errors.length > 0)) throw importValidationError(rowsToImport);
      const nextEntries = storage.entries.map((entry) => ({ ...entry }));
      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      for (const row of rowsToImport) {
        if (row.status === 'duplicate') { skippedCount += 1; continue; }
        const action = row.status === 'conflict' ? resolutions[String(row.rowNumber)] : 'create';
        if (action === 'skip') { skippedCount += 1; continue; }
        if (row.status === 'conflict' && action !== 'update') throw glossaryError('glossary_import_resolution_required', `Import resolution is required for row ${row.rowNumber}.`);
        if (action === 'update') {
          const index = nextEntries.findIndex((entry) => entry.id === row.conflict.existingEntryId);
          nextEntries[index] = normalizeMutableEntry({ ...row.entry, id: nextEntries[index].id, createdAt: nextEntries[index].createdAt, updatedAt: clock() }, index, new Set(storage.categories.map((category) => category.id)));
          updatedCount += 1;
        } else {
          nextEntries.push(normalizeMutableEntry({ ...row.entry, id: idFactory(), createdAt: clock(), updatedAt: clock() }, nextEntries.length, new Set(storage.categories.map((category) => category.id))));
          createdCount += 1;
        }
      }
      const nextStorage = { categories: storage.categories, entries: nextEntries };
      await writeStorage(fileSystem, filePath, nextStorage);
      invalidateCache(nextStorage);
      return { createdCount, updatedCount, skippedCount, total: rowsToImport.length };
    },

    async entriesFor(targetLanguageCode, options = {}) {
      assertSupportedTargetLanguageCode(targetLanguageCode);
      const scope = normalizeOptionalScope(options.scope);
      const entries = await loadEntries();
      return Object.freeze(
        entries
          .filter((entry) => entry.enabled !== false)
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

    async listCategories() {
      return (await loadStorage()).categories.map(cloneCategory);
    },

    async createCategory(input = {}) {
      assertConfigured(filePath);
      assertWritableFileSystem(fileSystem);
      const storage = await readStorage(fileSystem, filePath);
      const category = normalizeCategory({ ...input, id: input.id ?? idFactory() }, storage.categories.length);
      assertUniqueCategory(storage.categories, category);
      storage.categories.push({ ...category, sortOrder: storage.categories.length });
      await writeStorage(fileSystem, filePath, storage);
      invalidateCache(storage);
      return cloneCategory(storage.categories.at(-1));
    },

    async updateCategory(id, input = {}) {
      assertConfigured(filePath);
      assertWritableFileSystem(fileSystem);
      assertNonBlankString(id, 'categoryId');
      const storage = await readStorage(fileSystem, filePath);
      const index = storage.categories.findIndex((category) => category.id === id);
      if (index === -1) throw glossaryError('glossary_category_not_found', `Translation glossary category not found: ${id}`);
      const category = normalizeCategory({ ...storage.categories[index], ...input, id }, index);
      assertUniqueCategory(storage.categories, category, id);
      storage.categories[index] = { ...category, sortOrder: storage.categories[index].sortOrder };
      await writeStorage(fileSystem, filePath, storage);
      invalidateCache(storage);
      return cloneCategory(storage.categories[index]);
    },

    async reorderCategories(ids = []) {
      assertConfigured(filePath);
      assertWritableFileSystem(fileSystem);
      const storage = await readStorage(fileSystem, filePath);
      if (!Array.isArray(ids) || ids.length !== storage.categories.length || new Set(ids).size !== ids.length || ids.some((id) => !storage.categories.some((category) => category.id === id))) throw glossaryError('invalid_request', 'Category order is invalid.');
      storage.categories = ids.map((id, sortOrder) => ({ ...storage.categories.find((category) => category.id === id), sortOrder }));
      await writeStorage(fileSystem, filePath, storage);
      invalidateCache(storage);
      return storage.categories.map(cloneCategory);
    },

    async deleteCategory(id) {
      assertConfigured(filePath);
      assertWritableFileSystem(fileSystem);
      assertNonBlankString(id, 'categoryId');
      if (id === 'other') throw glossaryError('glossary_category_not_deletable', 'The other category cannot be deleted.');
      const storage = await readStorage(fileSystem, filePath);
      if (!storage.categories.some((category) => category.id === id)) throw glossaryError('glossary_category_not_found', `Translation glossary category not found: ${id}`);
      storage.categories = storage.categories.filter((category) => category.id !== id).map((category, sortOrder) => ({ ...category, sortOrder }));
      let reassignedEntryCount = 0;
      storage.entries = storage.entries.map((entry) => {
        if (entry.category !== id) return entry;
        reassignedEntryCount += 1;
        return { ...entry, category: 'other' };
      });
      await writeStorage(fileSystem, filePath, storage);
      invalidateCache(storage);
      return { category: cloneCategory(storage.categories.find((category) => category.id === 'other')), reassignedEntryCount };
    },

    async createEntry(input = {}) {
      assertConfigured(filePath);
      assertWritableFileSystem(fileSystem);
      const storage = await readStorage(fileSystem, filePath);
      const entry = normalizeMutableEntry({ ...input, id: input.id ?? idFactory(), createdAt: clock(), updatedAt: clock() }, storage.entries.length, new Set(storage.categories.map((category) => category.id)));
      if (storage.entries.some((candidate) => candidate.id === entry.id)) {
        const error = new Error(`Translation glossary entry already exists: ${entry.id}`);
        error.code = 'invalid_request';
        throw error;
      }

      storage.entries.push(entry);
      await writeStorage(fileSystem, filePath, storage);
      invalidateCache(storage);
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
      }, index, new Set(storage.categories.map((category) => category.id)));
      storage.entries[index] = entry;
      await writeStorage(fileSystem, filePath, storage);
      invalidateCache(storage);
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
      invalidateCache(storage);
      return cloneEntry(entry);
    }
  });

  function loadEntries() {
    if (entriesPromise === undefined) {
      entriesPromise = loadStorage().then((storage) => Object.freeze(storage.entries.map(cloneNormalizedEntry)));
    }
    return entriesPromise;
  }

  function loadStorage() {
    if (storagePromise === undefined) storagePromise = filePath === undefined ? Promise.resolve({ categories: cloneCategories(DEFAULT_CATEGORIES), entries: [] }) : readStorage(fileSystem, filePath);
    return storagePromise;
  }

  function invalidateCache(storage) {
    storagePromise = Promise.resolve({ categories: storage.categories.map(cloneCategory), entries: storage.entries.map(cloneNormalizedEntry) });
    entriesPromise = storagePromise.then((value) => Object.freeze(value.entries.map(cloneNormalizedEntry)));
  }
}

async function readStorage(fileSystem, filePath) {
  let content;
  try {
    content = await fileSystem.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { categories: cloneCategories(DEFAULT_CATEGORIES), entries: [] };
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new TypeError('Translation glossary JSON is invalid.');
  }

  return validateGlossary(parsed);
}

async function writeStorage(fileSystem, filePath, storage) {
  const normalized = validateGlossary(storage);
  const value = { categories: normalized.categories, entries: normalized.entries.map(serializeStoredEntry) };
  await fileSystem.mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await fileSystem.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fileSystem.rename(temporaryPath, filePath);
}

function validateGlossary(value) {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new TypeError('Translation glossary must contain an entries array.');
  }
  const categories = value.categories === undefined ? cloneCategories(DEFAULT_CATEGORIES) : validateCategories(value.categories);
  const categoryIds = new Set(categories.map((category) => category.id));
  const entries = value.entries.map((entry, index) => normalizeMutableEntry(entry, index, categoryIds));
  return { categories, entries };
}

async function buildImportPreview(storage, format, content, settings = {}) {
  const rows = await parseImportContent(format, content, settings);
  const categoryIds = new Set(storage.categories.map((category) => category.id));
  const seenKeys = new Set();
  const previewRows = rows.map(({ rowNumber, entry }) => {
    const errors = [];
    const warnings = [];
    try { normalizeMutableEntry(entry, rowNumber, categoryIds); } catch (error) { errors.push(error.message); }
    const key = glossaryEntryKey(entry);
    if (seenKeys.has(key)) warnings.push('Import contains a duplicate source term.');
    seenKeys.add(key);
    const existingEntry = storage.entries.find((candidate) => glossaryEntryKey(candidate) === key);
    const status = errors.length ? 'invalid' : warnings.length ? 'duplicate' : existingEntry ? 'conflict' : 'create';
    return { rowNumber, status, entry, conflict: existingEntry ? { existingEntryId: existingEntry.id, existingEntry: cloneEntry(existingEntry) } : null, errors, warnings };
  });
  return {
    baseRevision: glossaryRevision(storage),
    summary: {
      total: previewRows.length,
      valid: previewRows.filter((row) => row.errors.length === 0 && row.status !== 'duplicate').length,
      invalid: previewRows.filter((row) => row.errors.length > 0).length,
      creates: previewRows.filter((row) => row.status === 'create').length,
      updates: previewRows.filter((row) => row.status === 'conflict').length,
      duplicates: previewRows.filter((row) => row.status === 'conflict' || row.status === 'duplicate').length
    },
    rows: previewRows
  };
}

async function parseImportContent(format, content, { sourceLanguageCode = 'zh-Hant', targetLanguageCode = 'en', category = 'other' } = {}) {
  if (format !== 'csv' && format !== 'json' && format !== 'xlsx') throw glossaryError('glossary_import_invalid', 'Import format must be csv, json, or xlsx.');
  if (typeof content !== 'string' || content.trim() === '') throw glossaryError('glossary_import_invalid', 'Import content must not be empty.');
  if (!isSupportedLanguage(sourceLanguageCode) || !isSupportedLanguage(targetLanguageCode)) throw glossaryError('glossary_import_invalid', 'Import languages are invalid.');
  if (format === 'json') {
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw glossaryError('glossary_import_invalid', 'Import JSON is invalid.'); }
    const entries = parsed?.entries;
    if (!Array.isArray(entries)) throw glossaryError('glossary_import_invalid', 'Import JSON must contain an entries array.');
    return entries.map((entry, index) => {
      if (!isRecord(entry)) return { rowNumber: index + 1, entry };
      return { rowNumber: index + 1, entry: { ...entry, sourceLanguageCode, translations: { [targetLanguageCode]: entry.translation }, category } };
    });
  }
  if (format === 'xlsx') return parseXlsxContent(content, { sourceLanguageCode, targetLanguageCode, category });
  const records = parseCsv(content);
  if (records.length < 2) throw glossaryError('glossary_import_invalid', 'Import CSV must contain a header and at least one row.');
  const headers = records[0];
  if (!headers.includes('source') || !headers.includes('translation')) throw glossaryError('glossary_import_invalid', 'Import CSV requires source and translation columns.');
  return records.slice(1).map((values, index) => {
    const fields = Object.fromEntries(headers.map((header, headerIndex) => [header, values[headerIndex] ?? '']));
    return { rowNumber: index + 2, entry: { source: fields.source, sourceLanguageCode, translations: { [targetLanguageCode]: fields.translation }, category } };
  });
}

async function parseXlsxContent(content, { sourceLanguageCode, targetLanguageCode, category }) {
  let workbook;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(content, 'base64'));
  } catch { throw glossaryError('glossary_import_invalid', 'Import XLSX is invalid.'); }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw glossaryError('glossary_import_invalid', 'Import XLSX must contain a worksheet.');
  const records = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const values = [];
    row.eachCell({ includeEmpty: true }, (cell) => values.push(cell.value ?? ''));
    records.push({ rowNumber: row.number, values });
  });
  const headerIndex = records.findIndex(({ values }) => {
    const headers = values.map((value) => String(value).trim());
    return headers.includes('source') && headers.includes('translation');
  });
  if (headerIndex < 0) throw glossaryError('glossary_import_invalid', 'Import XLSX requires a header row containing source and translation columns.');
  const headers = records[headerIndex].values.map((value) => String(value).trim());
  const dataRecords = records.slice(headerIndex + 1).filter(({ values }) => values.some((value) => String(value ?? '').trim() !== ''));
  if (dataRecords.length === 0) throw glossaryError('glossary_import_invalid', 'Import XLSX must contain a header and at least one data row.');
  return dataRecords.map(({ rowNumber, values }) => {
    const fields = Object.fromEntries(headers.map((header, headerIndex) => [header, String(values[headerIndex] ?? '')]));
    return { rowNumber, entry: { source: fields.source, sourceLanguageCode, translations: { [targetLanguageCode]: fields.translation }, category } };
  });
}

function parseCsv(content) {
  const records = [];
  let record = [], field = '', quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) { if (char === '"' && content[index + 1] === '"') { field += '"'; index += 1; } else if (char === '"') quoted = false; else field += char; }
    else if (char === '"' && field === '') quoted = true;
    else if (char === ',') { record.push(field); field = ''; }
    else if (char === '\n' || char === '\r') { if (char === '\r' && content[index + 1] === '\n') index += 1; record.push(field); field = ''; if (record.some((value) => value !== '')) records.push(record); record = []; }
    else field += char;
  }
  record.push(field); if (record.some((value) => value !== '')) records.push(record);
  return records;
}

function glossaryEntryKey(entry) { return `${String(entry?.sourceLanguageCode || 'zh-Hant').trim()}\u0000${String(entry?.source || '').trim()}`; }

function glossaryRevision(storage) { return createHash('sha256').update(JSON.stringify({ categories: storage.categories, entries: storage.entries.map(serializeStoredEntry) })).digest('hex'); }

function importValidationError(rows) { const error = glossaryError('glossary_import_invalid', 'Import contains invalid rows.'); error.details = rows.filter((row) => row.errors.length > 0).map(({ rowNumber, errors }) => ({ rowNumber, errors })); return error; }

function validateCategories(value) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('Translation glossary categories must be a non-empty array.');
  const normalized = value.map((category, index) => normalizeCategory(category, index));
  if (!normalized.some((category) => category.id === 'other')) throw new TypeError('Translation glossary categories must contain other.');
  const ids = new Set();
  const labels = new Set();
  for (const category of normalized) {
    if (ids.has(category.id) || labels.has(category.label.toLocaleLowerCase())) throw new TypeError('Translation glossary category IDs and labels must be unique.');
    ids.add(category.id);
    labels.add(category.label.toLocaleLowerCase());
  }
  return normalized.sort((a, b) => a.sortOrder - b.sortOrder).map((category, sortOrder) => ({ ...category, sortOrder }));
}

function normalizeCategory(category, index = 0) {
  if (!isRecord(category)) throw new TypeError(`Translation glossary category ${index} must be an object.`);
  const id = assertNonBlankString(category.id, `Translation glossary category ${index}.id`).trim();
  const label = assertNonBlankString(category.label, `Translation glossary category ${index}.label`).trim();
  if (!/^[a-z][a-z0-9_-]*$/.test(id)) throw new TypeError(`Translation glossary category ${index}.id is invalid.`);
  return { id, label, sortOrder: Number.isInteger(category.sortOrder) && category.sortOrder >= 0 ? category.sortOrder : index, system: category.system === true };
}

function assertUniqueCategory(categories, category, currentId) {
  if (categories.some((candidate) => candidate.id !== currentId && candidate.id === category.id)) throw glossaryError('invalid_request', 'Category ID already exists.');
  if (categories.some((candidate) => candidate.id !== currentId && candidate.label.toLocaleLowerCase() === category.label.toLocaleLowerCase())) throw glossaryError('glossary_category_duplicate', 'Category label already exists.');
}

function glossaryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cloneCategory(category) {
  return { ...category };
}

function cloneCategories(categories) {
  return categories.map(cloneCategory);
}

function normalizeMutableEntry(entry, index, categoryIds = new Set(DEFAULT_CATEGORIES.map((category) => category.id))) {
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
  const sourceLanguageCode = entry.sourceLanguageCode === undefined ? 'zh-Hant' : entry.sourceLanguageCode;
  if (!isSupportedLanguage(sourceLanguageCode)) {
    throw new RangeError(`Translation glossary entry ${index} has unsupported source language: ${sourceLanguageCode}`);
  }
  const tags = entry.tags === undefined ? [] : entry.tags;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || tag.trim() === '')) {
    throw new TypeError(`Translation glossary entry ${index}.tags must be an array of non-empty strings.`);
  }
  const category = entry.category === undefined ? 'other' : entry.category;
  if (!categoryIds.has(category)) {
    const error = new RangeError(`Translation glossary entry ${index}.category is invalid.`);
    error.code = 'invalid_request';
    throw error;
  }
  const enabled = entry.enabled === undefined ? true : entry.enabled;
  if (typeof enabled !== 'boolean') throw new TypeError(`Translation glossary entry ${index}.enabled must be a boolean.`);

  return Object.freeze({
    id: entry.id === undefined ? legacyEntryId(index) : assertNonBlankString(entry.id, `Translation glossary entry ${index}.id`),
    source: entry.source,
    sourceLanguageCode,
    translations: Object.freeze({ ...entry.translations }),
    replacementAliases,
    scope: normalizeEntryScope(entry.scope, index),
    category,
    tags: Object.freeze(tags.map((tag) => tag.trim())),
    enabled,
    notes: entry.notes === undefined ? '' : assertOptionalString(entry.notes, `Translation glossary entry ${index}.notes`),
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

function assertOptionalString(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string.`);
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
  return JSON.parse(JSON.stringify(serializeStoredEntry(entry)));
}

function cloneNormalizedEntry(entry) {
  return JSON.parse(JSON.stringify(entry));
}

function serializeStoredEntry(entry) {
  return {
    id: entry.id,
    source: entry.source,
    sourceLanguageCode: entry.sourceLanguageCode,
    translations: entry.translations,
    ...(hasReplacementAliases(entry.replacementAliases) ? { replacementAliases: entry.replacementAliases } : {}),
    scope: entry.scope,
    category: entry.category,
    tags: entry.tags,
    enabled: entry.enabled,
    notes: entry.notes,
    ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
    ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt })
  };
}

function hasReplacementAliases(replacementAliases) {
  return Object.values(replacementAliases || {})
    .some((aliases) => Array.isArray(aliases) && aliases.length > 0);
}

function defaultIdFactory() {
  return `glossary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function legacyEntryId(index) {
  return `entry-${index}`;
}
