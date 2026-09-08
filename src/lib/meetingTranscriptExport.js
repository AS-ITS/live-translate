const TIMED_FORMATS = new Set(['srt', 'vtt']);

// TXT should mirror the readable Meeting transcript. Timed formats can use
// Cues only when every durable transcript chunk is represented by a Cue.
export function meetingExportSources(detail = {}, format = 'txt') {
  const items = Array.isArray(detail?.transcriptItems) ? detail.transcriptItems : [];
  const cues = Array.isArray(detail?.cues) ? detail.cues : [];

  if (format === 'txt' || !hasCompleteFinalCues(detail, cues)) {
    return { items, cues: [] };
  }

  return { items, cues };
}

export function hasCompleteFinalCues(detail = {}, cues = detail?.cues) {
  const segments = Array.isArray(detail?.segments) ? detail.segments : [];
  const finalCues = (Array.isArray(cues) ? cues : []).filter((cue) => cue?.status === 'final');
  const durableSegments = segments.filter((segment) => Array.isArray(segment?.checkpoint?.durableChunks) && segment.checkpoint.durableChunks.length > 0);

  if (durableSegments.length === 0 || finalCues.length === 0) return false;

  return durableSegments.every((segment) => {
    const segmentCues = finalCues.filter((cue) => cue?.segmentId === segment.id);
    const requiredStreams = segment.mode === 'transcription' || segment.checkpoint?.mode === 'transcription'
      || segment.checkpoint?.finalCues?.some((cue) => cue?.mode === 'transcription')
      ? ['source']
      : ['source', 'translation'];
    const chunksByStream = new Map(requiredStreams.map((stream) => [
      stream,
      segment.checkpoint.durableChunks.filter((chunk) => chunk?.stream === stream && meaningfulText(chunk?.text))
    ]));

    return requiredStreams.every((stream) => {
      const chunks = chunksByStream.get(stream);
      const cueText = segmentCues
        .map((cue) => stream === 'source' ? cue?.sourceText : cue?.translatedText)
        .filter(meaningfulText)
        .map(compactText)
        .join('');

      return chunks.length > 0 && chunks.every((chunk) => cueText.includes(compactText(chunk.text)));
    });
  });
}

function meaningfulText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function compactText(value) {
  return String(value).replace(/\s+/gu, '').trim();
}
