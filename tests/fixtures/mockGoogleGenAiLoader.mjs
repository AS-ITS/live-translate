const mockUrl = new URL('./mockGoogleGenAi.mjs', import.meta.url).href;

export async function resolve(specifier, context, defaultResolve) {
  if (specifier === '@google/genai') {
    return {
      url: mockUrl,
      shortCircuit: true
    };
  }

  return defaultResolve(specifier, context, defaultResolve);
}
