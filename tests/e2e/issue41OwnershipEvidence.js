const PREFIX = 'ISSUE41_PCM_OWNERSHIP ';
const SAFE_DIAGNOSTIC = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

function safeValue(value) {
  if (Number.isSafeInteger(value) && value >= 0 && value <= 255) return value;
  return typeof value === 'string' && SAFE_DIAGNOSTIC.test(value) ? value : null;
}

export function parseIssue41OwnershipConsole(message) {
  if (message.type() !== 'info') return null;
  const text = message.text();
  if (!text.startsWith(PREFIX)) return null;
  let input;
  try { input = JSON.parse(text.slice(PREFIX.length)); } catch { return null; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const status = safeValue(input.status);
  const reason = safeValue(input.reason);
  if (typeof status !== 'string' || reason === null) return null;
  const diagnostic = { status, reason };
  if (input.openErrorName !== undefined) {
    const name = safeValue(input.openErrorName);
    const code = safeValue(input.openErrorCode);
    if (typeof name !== 'string' || code === null) return null;
    diagnostic.openErrorName = name;
    diagnostic.openErrorCode = code;
  }
  return diagnostic;
}

export function collectIssue41OwnershipEvidence(page, evidence, save) {
  page.on('console', (message) => {
    const diagnostic = parseIssue41OwnershipConsole(message);
    if (!diagnostic) return;
    (evidence.ownershipDiagnostics ||= []).push(diagnostic);
    save();
  });
}
