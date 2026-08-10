export function numericDigitSequence(text) {
  return String(text || '').replace(/[^\p{Nd}]/gu, '');
}

export function missingNumericIntegrity(sourceText, translatedText) {
  const expectedDigits = numericDigitSequence(sourceText);
  if (!expectedDigits) return null;

  const actualDigits = numericDigitSequence(translatedText);
  if (actualDigits === expectedDigits) return null;

  return { expectedDigits, actualDigits };
}

export function hasNumericIntegrity(sourceText, translatedText) {
  return missingNumericIntegrity(sourceText, translatedText) === null;
}
