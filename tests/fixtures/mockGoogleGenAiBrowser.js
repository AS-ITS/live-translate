export const Modality = {
  AUDIO: 'AUDIO'
};

export class GoogleGenAI {
  constructor(options = {}) {
    window.__mockGoogleGenAI = window.__mockGoogleGenAI || {
      clients: [],
      liveConnects: [],
      liveSessions: []
    };
    window.__mockGoogleGenAI.clients.push(options);

    this.live = {
      connect: async (request) => {
        window.__mockGoogleGenAI.liveConnects.push(request);

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

        window.__mockGoogleGenAI.liveSessions.push(session);
        return session;
      }
    };
  }
}
