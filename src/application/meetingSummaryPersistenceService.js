import { mergeChunkSummaries } from './meetingSummaryService.js';

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
      if (existing?.status === 'completed') return existing;
      const pending = existing?.status === 'pending' ? existing : await summaryRepository.createSummary({ schemaVersion: 1, sourceType: null, sourceHash: null, sourceCueCount: 0, sourceCharacterCount: 0, summaryId: idGenerator('meeting-summary'), sessionId, kind: 'final', range: null, status: 'pending', model, summary: null, topics: [], decisions: [], actionItems: [], timeline: [], keywords: [], risks: [], openQuestions: [], followUpSuggestions: [], createdAt: clock(), completedAt: null });
      try {
        const result = await summaryService.generate({ sessionId, meetingId });
        const summary = validateGeneratedSummary(result);
        return await summaryRepository.updateSummary(pending.complete({
          ...summary,
          sourceType: result.sourceType,
          sourceHash: result.sourceHash,
          sourceCueCount: result.sourceCueCount,
          sourceCharacterCount: result.sourceCharacterCount,
          completedAt: clock()
        }));
      } catch (error) {
        await summaryRepository.updateSummary(pending.fail());
        throw error;
      }
    },
    async generatePartialAndPersist({ sessionId, meetingId, range } = {}) {
      assertString(sessionId, 'sessionId');
      assertString(meetingId, 'meetingId');
      const session = await sessionRepository.getSessionRecord(sessionId);
      if (!session?.sessionRecord) throw coded('session_not_found', `Session not found: ${sessionId}`);
      const existing = await summaryRepository.getSummaryByRange(sessionId, range?.rangeKey);
      if (existing?.status === 'completed') return existing;

      const pending = existing?.status === 'pending'
        ? existing
        : await summaryRepository.createSummary({
            summaryId: idGenerator('meeting-summary'), sessionId, kind: 'partial', range, status: 'pending', model,
            summary: null, topics: [], decisions: [], actionItems: [], timeline: [], keywords: [], risks: [], openQuestions: [], followUpSuggestions: [], createdAt: clock(), completedAt: null
          });

      try {
        const result = await summaryService.generatePartial({ sessionId, meetingId, range });
        const summary = validateGeneratedSummary(result);
        return await summaryRepository.updateSummary(pending.complete({ ...summary, completedAt: clock() }));
      } catch (error) {
        await summaryRepository.updateSummary(pending.fail());
        throw error;
      }
    },
    async generateFinalAndPersist({ sessionId, meetingId } = {}) {
      assertString(sessionId, 'sessionId');
      assertString(meetingId, 'meetingId');
      const session = await sessionRepository.getSessionRecord(sessionId);
      if (!session?.sessionRecord) throw coded('session_not_found', `Session not found: ${sessionId}`);
      const existing = await summaryRepository.getSummaryBySessionId(sessionId);
      if (existing?.status === 'completed') return existing;
      const ranges = await summaryService.listFinalCueRanges({ sessionId, meetingId });
      if (!ranges.length) return this.generateAndPersist({ sessionId, meetingId });
      const partials = await summaryRepository.listPartialSummariesBySessionId(sessionId);
      const completedPartials = partials.filter((item) => item.status === 'completed');
      const completedKeys = new Set();
      for (const partial of completedPartials) {
        if (completedKeys.has(partial.range.rangeKey)) throw coded('meeting_summary_range_duplicate', `Duplicate completed summary range: ${partial.range.rangeKey}`);
        completedKeys.add(partial.range.rangeKey);
      }
      const byRange = new Map(completedPartials.map((item) => [item.range.rangeKey, item]));
      const missing = ranges.filter((range) => !byRange.has(range.rangeKey));
      if (missing.length) throw coded('meeting_summary_partials_pending', `Partial meeting summaries are incomplete for ${missing.map((range) => range.rangeKey).join(', ')}.`);
      validateRanges(ranges, [...byRange.values()]);
      const pending = existing?.status === 'pending'
        ? existing
        : await summaryRepository.createSummary({ summaryId: idGenerator('meeting-summary'), sessionId, kind: 'final', range: null, status: 'pending', model, summary: null, topics: [], decisions: [], actionItems: [], timeline: [], keywords: [], risks: [], openQuestions: [], followUpSuggestions: [], createdAt: clock(), completedAt: null });
      try {
        const merged = mergeChunkSummaries(ranges.map((range) => byRange.get(range.rangeKey).summary));
        const source = typeof summaryService.buildSource === 'function' ? await summaryService.buildSource({ sessionId, meetingId }) : null;
        return await summaryRepository.updateSummary(pending.complete({ summary: merged, topics: merged.keyPoints, decisions: merged.decisions, actionItems: merged.actionItems, timeline: merged.timeline, keywords: merged.keywords, risks: merged.risks, openQuestions: merged.openQuestions, followUpSuggestions: merged.followUpSuggestions, ...(source ? { sourceType: source.sourceType, sourceHash: source.sourceHash, sourceCueCount: source.sourceCueCount, sourceCharacterCount: source.sourceCharacterCount } : {}), completedAt: clock() }));
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

function validateRanges(ranges, partials) {
  const seen = new Set();
  let previous = null;
  for (const range of ranges) {
    if (seen.has(range.rangeKey)) throw coded('meeting_summary_range_duplicate', `Duplicate summary range: ${range.rangeKey}`);
    seen.add(range.rangeKey);
    if (previous && range.segmentSequence <= previous.segmentSequence) throw coded('meeting_summary_range_order_invalid', 'Summary ranges are not chronological.');
    previous = range;
  }
  for (const partial of partials) if (!seen.has(partial.range.rangeKey)) throw coded('meeting_summary_range_unexpected', `Unexpected summary range: ${partial.range.rangeKey}`);
}

function validateGeneratedSummary(result) {
  const summary = result?.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw new TypeError('summary service returned no structured summary.');
  return {
    summary,
    topics: strings(summary.keyPoints, 'summary.keyPoints'),
    decisions: strings(summary.decisions, 'summary.decisions'),
    actionItems: strings(summary.actionItems, 'summary.actionItems'),
    timeline: timeline(summary.timeline),
    keywords: stringsOptional(summary.keywords),
    risks: stringsOptional(summary.risks),
    openQuestions: stringsOptional(summary.openQuestions),
    followUpSuggestions: stringsOptional(summary.followUpSuggestions)
  };
}
function timeline(value) { return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map((item) => JSON.parse(JSON.stringify(item))) : []; }
function stringsOptional(value) { return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []; }
function strings(value, field) { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new TypeError(`${field} must be an array of strings.`); return value; }
function assertMethod(value, method, name) { if (!value || typeof value[method] !== 'function') throw new TypeError(`${name}.${method} must be a function.`); }
function assertString(value, name) { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string.`); }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
