# Live Translate Product Spec

## Project Overview

Live Translate is a Session-oriented Real-time Multilingual Translation
Platform.
It lets a user speak mixed-language audio into the browser, sends live
microphone audio to Gemini Live API, and plays back a selected target-language
translation while showing source and translated transcripts.

The MVP is a single-user browser experience backed by a small Node.js service
that issues short-lived Gemini ephemeral tokens.

## Summary

Build a Session-oriented Real-time Multilingual Translation Platform with a
React + JavaScript frontend, a Node.js backend, and Gemini Live API using
`gemini-3.5-live-translate-preview`.

The browser captures microphone audio, converts it to raw PCM 16-bit 16kHz mono
chunks, and connects directly to Gemini Live API with a short-lived ephemeral
token issued by the backend. Gemini returns translated 24kHz PCM audio plus input
and output transcripts.

Current scope:

- Each user translation run creates one Session.
- The current session produces one selected target-language translation output.
- The Session preserves source transcript items for review and export.

Future scope:

- The same saved SourceTranscript may later produce additional
  TranslationOutput records.
- Re-translation should not require new audio input or re-recording.

## Goals

- Start and stop a Session from the browser.
- Let the user choose a target output language.
- Play translated audio in near real time.
- Show source and translated transcripts.
- Preserve the source transcript as the canonical input for future translations.
- Keep `GEMINI_API_KEY` only on the backend.
- Avoid proxying audio streams through the backend.

## Non-Goals

- User accounts.
- Persistent transcript history.
- Room sharing or multi-user calls.
- Text input translation.
- Full benchmark or real API validation in automated tests.
- Server-side audio processing, recording, or relaying.

## MVP Scope

The MVP includes:

- A browser UI for selecting a target language.
- A browser UI for starting and stopping a Session.
- Microphone permission handling.
- Browser-side microphone capture.
- Browser-side audio conversion to the Gemini input audio format.
- Direct browser connection to Gemini Live API using a backend-issued ephemeral
  token.
- Playback of translated audio returned by Gemini.
- Display of input and output transcripts.
- A backend endpoint for ephemeral token issuance.
- Validation of supported target languages and token options.
- Session-local source transcript preservation for later export or review.

## Functional Requirements

- The user can select one supported target language before starting a session.
- The default target language is English (`en`).
- The user can start a live translation session.
- The browser requests microphone permission before streaming audio.
- The browser streams microphone audio to Gemini Live API while the session is
  active.
- The app plays translated audio returned by Gemini.
- The app displays source transcript updates.
- The app displays translated transcript updates.
- The user can stop the session.
- Stopping a session closes microphone tracks and ends the Gemini Live session.
- The app shows recoverable errors and allows the user to retry.
- The backend rejects unsupported target languages.
- The backend never exposes `GEMINI_API_KEY` to the browser.

## Non-Functional Requirements

- Audio translation should feel near real time for normal speech.
- The backend should remain stateless for MVP token issuance.
- The backend should perform the smallest required validation before creating a
  token.
- The frontend should keep session state explicit and recoverable.
- Automated tests should use mocks or deterministic helpers instead of real
  model APIs.
- Real Gemini API testing requires explicit manual approval.
- Secrets must be loaded from environment variables and excluded from git.

## User Flow

1. The user opens the web app.
2. The user selects a target language or keeps the default `en`.
3. The user clicks start.
4. The browser requests microphone permission.
5. The frontend requests an ephemeral token from `POST /api/live-token`.
6. The frontend connects directly to Gemini Live API with the ephemeral token.
7. The browser sends microphone audio chunks to Gemini.
8. Gemini returns translated audio and transcript events.
9. The frontend plays translated audio and updates transcripts.
10. The user clicks stop.
11. The frontend closes the Gemini session and stops microphone tracks.

## Supported MVP Languages

- English: `en`
- Japanese: `ja`
- Korean: `ko`
- Traditional Chinese: `zh-Hant`
- Simplified Chinese: `zh-Hans`
- Spanish: `es`
- French: `fr`
- German: `de`

Default target language: `en`.

## Future Enhancements

- Persist transcript history.
- Add user accounts.
- Support shared rooms or multi-user sessions.
- Add source language selection.
- Add text input translation.
- Add downloadable transcript exports.
- Add configurable voices or playback settings.
- Add usage metrics and operational dashboards.
- Add broader browser compatibility testing.
- Reopen a saved Session and generate additional TranslationOutput records from
  the same SourceTranscript without re-recording audio.
