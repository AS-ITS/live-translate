import { randomUUID } from 'node:crypto';
import { currentRequestOwnerId } from '../../server/requestIdentity.js';
import { eq } from './supabaseRestClient.js';
import { createSupabaseRequestClient, requireSupabaseRequestClient } from './supabaseRequestClient.js';

// Supabase-backed glossary port. The public shape intentionally matches the
// legacy glossary service so controllers and providers stay storage-agnostic.
export function createSupabaseGlossary({ env = process.env, fetchImpl = globalThis.fetch, idFactory = randomUUID } = {}) {
  const clientForRequest = createSupabaseRequestClient({ env, fetchImpl });
  const client = { request: (...args) => requireSupabaseRequestClient(clientForRequest).request(...args) };
  const owner = () => currentRequestOwnerId() || env.SUPABASE_WORKER_USER_ID || failOwner();
  const rows = (table, query) => client.request(table, { query });
  const entryDTO = (row) => ({
    id: row.id, source: row.source, sourceLanguageCode: row.source_language_code,
    translations: { [row.target_language_code]: row.translation },
    scope: row.scope || 'both', category: row.category_id || row.category || 'other',
    tags: row.tags || [], enabled: row.enabled !== false, notes: row.notes || '',
    createdAt: row.created_at, updatedAt: row.updated_at
  });
  return Object.freeze({
    requiresRequestIdentity: true,
    async entriesFor(targetLanguageCode, options = {}) {
      const result = await this.listEntries();
      return result.filter((entry) => entry.enabled && entry.translations[targetLanguageCode]
        && (!options.scope || entry.scope === options.scope || entry.scope === 'both'))
        .map((entry) => ({ source: entry.source, target: entry.translations[targetLanguageCode], replacementAliases: [] }));
    },
    async listEntries() {
      const userId = owner();
      const result = await rows('glossary_entries', `?select=*&${eq('owner_user_id', userId)}&order=created_at.asc`);
      return result.map(entryDTO);
    },
    async listCategories() {
      const userId = owner();
      const result = await rows('glossary_categories', `?select=*&${eq('owner_user_id', userId)}&order=sort_order.asc`);
      return result.map((row) => ({ id: row.id, label: row.label, sortOrder: row.sort_order, system: row.system === true }));
    },
    async createCategory(input = {}) {
      const userId = owner();
      const row = { id: input.id || idFactory(), owner_user_id: userId, label: String(input.label || '').trim(), sort_order: Number(input.sortOrder || 0), system: false };
      const result = await client.request('glossary_categories', { method: 'POST', body: [row] });
      return { id: row.id, label: row.label, sortOrder: row.sort_order, system: false, ...(result[0] || {}) };
    },
    async updateCategory(id, input = {}) {
      const result = await client.request('glossary_categories', { method: 'PATCH', query: `?${eq('id', id)}&${eq('owner_user_id', owner())}`, body: { label: input.label, sort_order: input.sortOrder } });
      return result[0] || null;
    },
    async reorderCategories(ids = []) {
      await Promise.all(ids.map((id, index) => this.updateCategory(id, { sortOrder: index })));
      return this.listCategories();
    },
    async deleteCategory(id) {
      await client.request('glossary_categories', { method: 'DELETE', query: `?${eq('id', id)}&${eq('owner_user_id', owner())}` });
      return true;
    },
    async createEntry(input = {}) {
      return writeEntry(input);
    },
    async updateEntry(id, input = {}) {
      const normalized = normalizeEntry(input);
      const result = await client.request('glossary_entries', { method: 'PATCH', query: `?${eq('id', id)}&${eq('owner_user_id', owner())}`, body: { ...normalized, id } });
      return entryDTO(result[0] || { ...normalized, id });
    },
    async deleteEntry(id) {
      await client.request('glossary_entries', { method: 'DELETE', query: `?${eq('id', id)}&${eq('owner_user_id', owner())}` });
      return true;
    },
    async previewImport(input = {}) { return parseImport(input); },
    async previewPrivateImport(input = {}) { return parseImport(input); },
    async importEntries(input = {}) {
      const preview = await parseImport(input);
      const selected = input.selectedRows ? preview.rows.filter((row) => input.selectedRows.includes(row.rowNumber)) : preview.rows;
      for (const row of selected.filter((candidate) => candidate.status !== 'duplicate' && candidate.status !== 'invalid')) await writeEntry(row.entry);
      return { createdCount: selected.length, updatedCount: 0, skippedCount: preview.rows.length - selected.length, total: selected.length };
    }
  });

  async function writeEntry(input) {
    const normalized = normalizeEntry(input);
    const result = await client.request('glossary_entries', { method: 'POST', body: [{ id: input.id || idFactory(), owner_user_id: owner(), ...normalized }] });
    return entryDTO(result[0] || { ...normalized, id: input.id || null });
  }
  function normalizeEntry(input) {
    const target = Object.keys(input.translations || {})[0] || input.targetLanguageCode || 'en';
    return { source: input.source, translation: input.translation || input.translations?.[target], source_language_code: input.sourceLanguageCode, target_language_code: target, category_id: input.category || input.categoryId || null, scope: input.scope || 'both', tags: input.tags || [], enabled: input.enabled !== false, notes: input.notes || '' };
  }
}

async function parseImport({ format, content, sourceLanguageCode, targetLanguageCode, category } = {}) {
  let values;
  if (format === 'json') values = JSON.parse(content).entries || [];
  else values = String(content || '').split(/\r?\n/u).slice(1).filter(Boolean).map((line) => { const [source, translation] = line.split(','); return { source, translation }; });
  return { rows: values.map((entry, index) => ({ rowNumber: index + 2, status: entry.source && entry.translation ? 'create' : 'invalid', errors: entry.source && entry.translation ? [] : ['source and translation are required'], entry: { ...entry, sourceLanguageCode, targetLanguageCode, category } })), summary: {} };
}

function failOwner() { const error = new Error('Authenticated owner required.'); error.code = 'auth_required'; error.status = 401; throw error; }
