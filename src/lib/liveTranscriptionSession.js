import { LiveTranslateSession } from './liveSession.js';

/**
 * Source-only Live session. The shared base owns microphone capture,
 * ephemeral-token setup, cleanup, recovery diagnostics, and connection epochs;
 * this boundary selects transcription mode and never emits translated audio.
 */
export class LiveTranscriptionSession extends LiveTranslateSession {
  constructor(options = {}) {
    super({ ...options, mode: 'transcription', echoTargetLanguage: false });
  }
}
