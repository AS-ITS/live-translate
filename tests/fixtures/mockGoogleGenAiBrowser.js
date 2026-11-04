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

        if (window.__mockLiveConnectDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, window.__mockLiveConnectDelayMs));
        }

        const session = {
          closed: false,
          sentInputs: [],
          audioInputCount: 0,
          inputCount: 0,
          sentClientContent: [],
          sendRealtimeInput(input) {
            this.inputCount += 1;
            if (window.__issue41BoundMockPcm && input?.audio) {
              this.audioInputCount += 1;
              if (this.audioInputCount === 1) this.sentInputs.push({ audio: true });
            } else {
              this.sentInputs.push(input);
            }
            if (input?.audioStreamEnd === true || input?.activityEnd) {
              setTimeout(() => request.callbacks?.onmessage?.({
                eventId: `mock-provider-boundary-${this.inputCount}`,
                serverContent: { turnComplete: true, generationComplete: true }
              }), 0);
            }
          },
          sendClientContent(content) {
            this.sentClientContent.push(content);
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
        if (window.__mockLiveCloseOnConnectNumber === window.__mockGoogleGenAI.liveConnects.length) {
          session.closed = true;
          request.callbacks?.onclose?.({ reason: 'mock-setup-close', code: 1011 });
          window.__mockGoogleGenAI.liveSessions.push(session);
          return session;
        }
        setTimeout(() => request.callbacks?.onmessage?.({ setupComplete: {} }), 0);

        window.__mockGoogleGenAI.liveSessions.push(session);
        return session;
      }
    };
  }
}
