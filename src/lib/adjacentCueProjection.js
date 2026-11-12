import { effectiveSourceForCue, effectiveTranslationForCue } from './cueContent.js';

const MAX_GAP_MS = 1200;
const MAX_TEXT_LENGTH = 120;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function text(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function join(left, right) {
  const first = text(left);
  const second = text(right);
  if (!first) return second;
  if (!second || first === second || first.startsWith(second)) return first;
  if (second.startsWith(first)) return second;
  const separator = CJK.test(first) && /^[\d\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(second)
    || /^[\p{P}\p{S}]/u.test(second) ? '' : ' ';
  return `${first}${separator}${second}`;
}

function canProject(previous, next, stream) {
  if (previous?.status !== 'final' || next?.status !== 'final') return false;
  if (previous.finalizedReason === 'length' || next.finalizedReason === 'length') return false;
  for (const field of ['sessionId', 'liveSessionId', 'segmentId', 'audioTurnId', 'sourceLanguageCode', 'targetLanguageCode']) {
    if (previous[field] && next[field] && previous[field] !== next[field]) return false;
  }
  if (previous.sequence + (previous.projectionCueIds?.length || 1) !== next.sequence) return false;
  if (!Number.isFinite(previous.endTimeMs) || !Number.isFinite(next.startTimeMs)
    || Math.max(0, next.startTimeMs - previous.endTimeMs) > MAX_GAP_MS) return false;
  const source = effectiveSourceForCue(previous, 'raw');
  const translation = effectiveTranslationForCue(previous);
  const nextSource = effectiveSourceForCue(next, 'raw');
  const nextTranslation = effectiveTranslationForCue(next);
  if (stream !== 'translation' && (!source || !nextSource)) return false;
  if (stream !== 'source' && (!translation || !nextTranslation)) return false;
  // Repeated or cumulative content can describe one provider revision, not a new fragment.
  if (stream !== 'translation' && source && nextSource
    && (source === nextSource || nextSource.startsWith(source))) return false;
  if (stream !== 'source' && translation && nextTranslation
    && (translation === nextTranslation || nextTranslation.startsWith(translation))) return false;
  if (stream !== 'translation' && /[.!?。！？…]+["'”’」』）)]*$/u.test(source)) return false;
  if (stream !== 'source' && /[.!?。！？…]+["'”’」』）)]*$/u.test(translation)) return false;
  const parts = stream === 'source' ? [source, nextSource]
    : stream === 'translation' ? [translation, nextTranslation]
      : [source, translation, nextSource, nextTranslation];
  if (!parts.some((part) => /[,，、:：;；]$/u.test(part) || /^\d[\d\s]*$/u.test(part))) return false;
  return (stream === 'translation' || join(source, nextSource).length <= MAX_TEXT_LENGTH)
    && (stream === 'source' || join(translation, nextTranslation).length <= MAX_TEXT_LENGTH);
}

// Projection rows have stable first-Cue IDs; the input Cues and their event evidence stay untouched.
export function projectAdjacentFinalCues(cues = [], { stream = 'both' } = {}) {
  const projected = [];
  for (const cue of cues) {
    const previous = projected.at(-1);
    if (!canProject(previous, cue, stream)) {
      projected.push(cue);
      continue;
    }
    const source = join(effectiveSourceForCue(previous, 'raw'), effectiveSourceForCue(cue, 'raw'));
    const translation = join(effectiveTranslationForCue(previous), effectiveTranslationForCue(cue));
    const rawTranslation = join(effectiveTranslationForCue(previous, 'raw'), effectiveTranslationForCue(cue, 'raw'));
    projected[projected.length - 1] = {
      cueId: previous.cueId,
      projectionCueIds: [...(previous.projectionCueIds || [previous.cueId]), cue.cueId],
      status: 'final',
      sessionId: previous.sessionId,
      liveSessionId: previous.liveSessionId,
      segmentId: previous.segmentId,
      audioTurnId: previous.audioTurnId,
      sequence: previous.sequence,
      startTimeMs: previous.startTimeMs,
      endTimeMs: Math.max(previous.endTimeMs, cue.endTimeMs),
      updatedTimeMs: Math.max(previous.updatedTimeMs || 0, cue.updatedTimeMs || 0),
      sourceLanguageCode: previous.sourceLanguageCode,
      targetLanguageCode: previous.targetLanguageCode,
      __exportVariant: previous.__exportVariant,
      sourceText: source,
      rawSource: source,
      translatedText: translation,
      rawTranslation,
      initialTranslation: translation
    };
  }
  return projected;
}
