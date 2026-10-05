export async function stopSessionSafely(session) {
  if (!session || typeof session.stop !== 'function') return false;

  try {
    await session.stop();
    return true;
  } catch {
    return false;
  }
}
