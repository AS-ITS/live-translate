# Live Translate

Live Translate is a real-time speech translation web app using a React frontend,
a Node.js backend, and the Gemini Live API. The backend owns `GEMINI_API_KEY` and
issues short-lived ephemeral tokens so the browser can connect directly to the
Gemini Live API.

## Current Status

Current milestone: v0.5.0 - Phase 2 Foundation

Completed:

- Phase 1 Demo
- Real-time Gemini Live translation
- Ephemeral token flow
- Transcript handling
- Transcript export
- Audio input device selection
- Session lifecycle specification
- Security hardening
- Testing documentation

Planned next capability:

- Connection Resilience
  - Auto Reconnect
  - Token Refresh
  - Retry Policy
  - Timeout Strategy
  - Recovery UX
