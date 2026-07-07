export const Modality = {
  AUDIO: 'AUDIO'
};

function state() {
  if (!globalThis.__mockGoogleGenAI) {
    globalThis.__mockGoogleGenAI = {
      clients: [],
      tokenCreates: [],
      liveConnects: [],
      liveSessions: []
    };
  }

  return globalThis.__mockGoogleGenAI;
}

export class GoogleGenAI {
  constructor(options = {}) {
    this.options = options;
    state().clients.push(options);

    this.authTokens = {
      create: async ({ config }) => {
        state().tokenCreates.push({ config });

        if (process.env.MOCK_GOOGLE_GENAI_AUTH_ERROR) {
          throw new Error(process.env.MOCK_GOOGLE_GENAI_AUTH_ERROR);
        }

        return { name: process.env.MOCK_GOOGLE_GENAI_TOKEN_NAME || 'mock-ephemeral-token' };
      }
    };

    this.live = {
      connect: async (request) => {
        state().liveConnects.push(request);

        if (process.env.MOCK_GOOGLE_GENAI_LIVE_ERROR) {
          throw new Error(process.env.MOCK_GOOGLE_GENAI_LIVE_ERROR);
        }

        const session = {
          closed: false,
          sentInputs: [],
          sendRealtimeInput(input) {
            this.sentInputs.push(input);
          },
          close() {
            this.closed = true;
            request.callbacks?.onclose?.({ reason: 'mock-close', code: 1000 });
          }
        };

        state().liveSessions.push(session);
        return session;
      }
    };
  }
}
