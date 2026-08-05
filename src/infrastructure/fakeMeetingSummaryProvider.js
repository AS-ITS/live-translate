export function createFakeMeetingSummaryProvider() {
  return Object.freeze({
    async summarizeChunk({ cues = [] } = {}) {
      const sourceTexts = cues.map((cue) => String(cue?.sourceText || '').trim()).filter(Boolean);
      return {
        title: 'Mock Meeting Summary',
        overview: sourceTexts.join(' '),
        keyPoints: sourceTexts,
        decisions: [],
        actionItems: [],
        timeline: [],
        keywords: [],
        risks: [],
        openQuestions: [],
        followUpSuggestions: []
      };
    }
  });
}
