const DEFAULT_VIEWER_PAGE_SIZE = 100;
const MAX_VIEWER_PAGE_SIZE = 100;

export function normalizeViewerPageSize(value = DEFAULT_VIEWER_PAGE_SIZE) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_VIEWER_PAGE_SIZE) {
    throw invalidViewerCursorError('Viewer page size must be an integer from 1 to 100.');
  }
  return parsed;
}

export function encodeViewerCursor({ segmentSequence, sequence, cueId } = {}) {
  if (!Number.isSafeInteger(segmentSequence) || segmentSequence < 0 ||
      !Number.isSafeInteger(sequence) || sequence < 1 ||
      typeof cueId !== 'string' || cueId.length === 0) {
    throw invalidViewerCursorError('Viewer cursor is invalid.');
  }

  return Buffer.from(JSON.stringify({ v: 1, segmentSequence, sequence, cueId }), 'utf8').toString('base64url');
}

export function decodeViewerCursor(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 512) {
    throw invalidViewerCursorError('Viewer cursor is invalid.');
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalidViewerCursorError('Viewer cursor is invalid.');
  }

  if (parsed?.v !== 1 || !Number.isSafeInteger(parsed.segmentSequence) || parsed.segmentSequence < 0 ||
      !Number.isSafeInteger(parsed.sequence) || parsed.sequence < 1 ||
      typeof parsed.cueId !== 'string' || parsed.cueId.length === 0) {
    throw invalidViewerCursorError('Viewer cursor is invalid.');
  }

  return parsed;
}

export function compareViewerCues(left, right) {
  return (Number(left?.segmentSequence) || 0) - (Number(right?.segmentSequence) || 0) ||
    (Number(left?.sequence) || 0) - (Number(right?.sequence) || 0) ||
    String(left?.cueId || '').localeCompare(String(right?.cueId || ''));
}

function invalidViewerCursorError(message) {
  const error = new TypeError(message);
  error.code = 'invalid_request';
  error.status = 400;
  return error;
}
