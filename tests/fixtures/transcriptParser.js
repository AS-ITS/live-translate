export function createTranscriptState() {
  return { finalText: '', partialText: '' };
}

export function updateTranscript(current, update) {
  const next = update.text?.trim() || '';
  if (!next) {
    return current;
  }

  if (update.isFinal) {
    return {
      finalText: current.finalText ? `${current.finalText} ${next}` : next,
      partialText: ''
    };
  }

  return {
    ...current,
    partialText: next
  };
}

export function transcriptText(transcript) {
  return [transcript.finalText, transcript.partialText].filter(Boolean).join(' ');
}
