export function newerViewerMetadata(current, incoming) {
  if (!current) return incoming;
  if (current.meeting?.id !== incoming.meeting?.id) return current;
  return Number(incoming.meeting.lifecycleVersion) > Number(current.meeting.lifecycleVersion) ? incoming : current;
}
