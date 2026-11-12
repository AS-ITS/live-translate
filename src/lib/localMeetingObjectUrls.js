const activeUrls = new Set();

export function createLocalMeetingObjectUrl(blob) {
  const url = URL.createObjectURL(blob);
  activeUrls.add(url);
  return url;
}

export function revokeLocalMeetingObjectUrl(url) {
  if (!activeUrls.delete(url)) return;
  URL.revokeObjectURL(url);
}

export function clearLocalMeetingObjectUrls() {
  for (const url of activeUrls) revokeLocalMeetingObjectUrl(url);
}
