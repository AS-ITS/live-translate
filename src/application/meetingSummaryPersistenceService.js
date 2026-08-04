import { MeetingSummary } from '../domain/meetingSummary/index.js';

export function createMeetingSummaryPersistenceService({ summaryRepository, summaryService, sessionRepository, model, idGenerator, clock } = {}) {
  assertMethod(summaryRepository, 'createSummary', 'summaryRepository');
  assertMethod(summaryRepository, 'getSummaryBySessionId', 'summaryRepository');
  assertMethod(summaryRepository, 'updateSummary', 'summaryRepository');
  assertMethod(summaryService, 'generate', 'summaryService');
  assertMethod(sessionRepository, 'getSessionRecord', 'sessionRepository');
  assertString(model, 'model');
  if (typeof idGenerator !== 'function') throw new TypeError('idGenerator must be a function.');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');

  return Object.freeze({
    async generateAndPersist({ sessionId, meetingId } = {}) {
      assertString(sessionId, 'sessionId');
      assertString(meetingId, 'meetingId');
      const session = await sessionRepository.getSessionRecord(sessionId);
      if (!session?.sessionRecord) throw coded('session_not_found', `Session not found: ${sessionId}`);
      const existing = await summaryRepository.getSummaryBySessionId(sessionId);
      if (existing && existing.status !== 'failed') return existing;

      const pending = await summaryRepository.createSummary({
        summaryId: idGenerator('meeting-summary'), sessionId, status: 'pending', model,
        summary: null, topics: [], decisions: [], actionItems: [], createdAt: clock(), completedAt: null
      });

      try {
        const result = await summaryService.generate({ meetingId });
        const summary = validateGeneratedSummary(result);
        return await summaryRepository.updateSummary(pending.complete({ ...summary, completedAt: clock() }));
      } catch (error) {
        await summaryRepository.updateSummary(pending.fail());
        throw error;
      }
    },
    async listBySessionId(sessionId) {
      assertString(sessionId, 'sessionId');
      return summaryRepository.listSummariesBySessionId(sessionId);
    }
  });
}

function validateGeneratedSummary(result) {
  const summary = result?.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw new TypeError('summary service returned no structured summary.');
  return {
    summary,
    topics: strings(summary.keyPoints, 'summary.keyPoints'),
    decisions: strings(summary.decisions, 'summary.decisions'),
    actionItems: strings(summary.actionItems, 'summary.actionItems')
  };
}
function strings(value, field) { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new TypeError(`${field} must be an array of strings.`); return value; }
function assertMethod(value, method, name) { if (!value || typeof value[method] !== 'function') throw new TypeError(`${name}.${method} must be a function.`); }
function assertString(value, name) { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string.`); }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
