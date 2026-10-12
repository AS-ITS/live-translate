export function classifyAuthTransition({
  event,
  currentSession,
  nextSession,
  validatedUserId = null
} = {}) {
  const nextUserId = nextSession?.user?.id || null;
  if (!nextSession || event === 'SIGNED_OUT' || !nextUserId) {
    return Object.freeze({ kind: 'signed-out', userId: null, blockingProfileCheck: false });
  }

  const currentUserId = currentSession?.user?.id || null;
  const sameUser = Boolean(currentUserId && currentUserId === nextUserId);
  return Object.freeze({
    kind: sameUser ? 'same-user' : 'identity-changed',
    userId: nextUserId,
    blockingProfileCheck: validatedUserId !== nextUserId
  });
}
