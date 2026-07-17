export function createSystemClock() {
  return Object.freeze({
    now() {
      return new Date().toISOString();
    }
  });
}
