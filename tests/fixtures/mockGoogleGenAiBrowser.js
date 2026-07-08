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
          emitMessage(message) {
            request.callbacks?.onmessage?.(message);
          },
          emitError(error) {
            request.callbacks?.onerror?.(error);
          },
          emitClose(event = { reason: 'mock-close', code: 1000 }) {
            request.callbacks?.onclose?.(event);
          },
          close() {
            this.closed = true;
            this.emitClose();
          }
        };

        window.__mockGoogleGenAI.liveSessions.push(session);
        return session;
      }
    };
  }
}
