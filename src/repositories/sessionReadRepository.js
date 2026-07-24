import {
  mapSessionRecordDetailToDTO,
  mapSessionRecordToHistoryListItem
} from '../readModels/sessionReadModels.js';

export const SESSION_READ_REPOSITORY_METHODS = Object.freeze(['listSessionHistory', 'getSessionDetail']);

export function createSessionReadRepository({ sessionRepository } = {}) {
  if (!sessionRepository) {
    throw new Error('sessionRepository is required.');
  }

  return {
    listSessionHistory() {
      const records = sessionRepository.listSessionRecords();

      return mapMaybePromise(records, mapHistoryRecords);
    },

    getSessionDetail(sessionId) {
      const detail = sessionRepository.getSessionRecord(sessionId);

      return mapMaybePromise(detail, mapSessionDetail);
    }
  };
}

function mapMaybePromise(value, mapper) {
  if (value && typeof value.then === 'function') {
    return value.then(mapper);
  }

  return mapper(value);
}

function mapHistoryRecords(records) {
  return records
    .filter((record) => (record?.recordKind ?? 'session') === 'session')
    .map(mapSessionRecordToHistoryListItem);
}

function mapSessionDetail(detail) {
  if (!detail) {
    return null;
  }

  return mapSessionRecordDetailToDTO(detail);
}
