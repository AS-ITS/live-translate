import {
  createSessionRecord as createSessionRecordModel,
  createTranscriptItemForSession,
  finalizeSessionRecord as finalizeSessionRecordModel,
  summarizeTranscriptItems,
  updateSessionRecord as updateSessionRecordModel
} from './sessionRecords.js';

export const SESSION_REPOSITORY_METHODS = Object.freeze([
  'createSessionRecord',
  'updateSessionRecord',
  'appendTranscriptItem',
  'finalizeSessionRecord',
  'listSessionRecords',
  'getSessionRecord',
  'deleteSessionRecord'
]);

export function createMemorySessionRepository(options = {}) {
  const records = new Map();
  const transcriptItems = new Map();

  return {
    createSessionRecord(input = {}) {
      const record = createSessionRecordModel(input, options);

      if (records.has(record.id)) {
        throw new Error(`Session record already exists: ${record.id}`);
      }

      records.set(record.id, cloneRecord(record));
      transcriptItems.set(record.id, []);

      return cloneRecord(record);
    },

    updateSessionRecord(id, patch = {}) {
      const record = requireRecord(records, id);
      const updated = updateSessionRecordModel(record, patch, options);

      records.set(id, cloneRecord(updated));

      return cloneRecord(updated);
    },

    appendTranscriptItem(sessionId, item = {}) {
      const record = requireRecord(records, sessionId);
      const existingItems = transcriptItems.get(sessionId) || [];
      const sessionItem = createTranscriptItemForSession(sessionId, item);
      const nextItems = [...existingItems, cloneTranscriptItem(sessionItem)];
      const updatedRecord = updateSessionRecordModel(
        record,
        { transcriptSummary: summarizeTranscriptItems(nextItems) },
        options
      );

      transcriptItems.set(sessionId, nextItems);
      records.set(sessionId, cloneRecord(updatedRecord));

      return cloneTranscriptItem(sessionItem);
    },

    finalizeSessionRecord(id, patch = {}) {
      const record = requireRecord(records, id);
      const items = transcriptItems.get(id) || [];
      const finalPatch = {
        ...patch,
        transcriptSummary: patch.transcriptSummary ?? summarizeTranscriptItems(items)
      };
      const finalized = finalizeSessionRecordModel(record, finalPatch, options);

      records.set(id, cloneRecord(finalized));

      return cloneRecord(finalized);
    },

    listSessionRecords() {
      return Array.from(records.values(), cloneRecord);
    },

    getSessionRecord(id) {
      const record = records.get(id);

      if (!record) {
        return null;
      }

      return {
        sessionRecord: cloneRecord(record),
        transcriptItems: (transcriptItems.get(id) || []).map(cloneTranscriptItem)
      };
    },

    deleteSessionRecord(id) {
      const deletedRecord = records.delete(id);
      const deletedTranscriptItems = transcriptItems.delete(id);

      return deletedRecord || deletedTranscriptItems;
    }
  };
}

function requireRecord(records, id) {
  const record = records.get(id);

  if (!record) {
    throw new Error(`Session record not found: ${id}`);
  }

  return record;
}

function cloneRecord(record) {
  return {
    ...record,
    transcriptSummary: record.transcriptSummary ? { ...record.transcriptSummary } : record.transcriptSummary
  };
}

function cloneTranscriptItem(item) {
  return {
    ...item,
    ...(item.sourceLanguageDetection && typeof item.sourceLanguageDetection === 'object'
      ? {
          sourceLanguageDetection: {
            ...item.sourceLanguageDetection,
            ...(Array.isArray(item.sourceLanguageDetection.detectedLanguageCodes)
              ? { detectedLanguageCodes: [...item.sourceLanguageDetection.detectedLanguageCodes] }
              : {})
          }
        }
      : {})
  };
}
