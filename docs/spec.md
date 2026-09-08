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
the current source transcription path. The older Live speech-to-speech model
description is retained only for compatibility; the target pipeline uses
`gemini-3.5-transcribe-live` for meeting text.

The browser captures microphone audio, converts it to raw PCM 16-bit 16kHz mono
chunks, and connects directly to Gemini Live API with a short-lived ephemeral
token issued by the backend. The current Live recording path uses Gemini Live
transcription and persists source-language subtitle events. Existing saved
translation outputs remain readable for compatibility.

## Realtime subtitle pipeline (target architecture)

The planned meeting transcript pipeline has four explicit stages:

```text
Transcribe Live
  → finalized source Cue
  → async Flash translation
  → async Flash refinement
  → history / export / summary
```

The current Meeting runtime uses the direct Live translation path. Finalized
source and translated transcript events are paired into the same Cue during
recording. The source-only plus asynchronous Flash path remains available for
future work and is not used by the active Meeting recorder.

An interim transcription is a presentation-only preview. It must not enter
persistence, translation, refinement, export, history, or summary. A finalized
Cue is the formal source record and is the only input to those downstream
capabilities. Initial and refined translations are attached to the same
`cueId`; translation or refinement failure is recoverable and must never block
the live transcription path.

Readers should resolve the displayed translation in this order:

```text
refinedTranslation → initialTranslation → legacy translatedText
```

History, export, and summary consume finalized Cues, not interim text. The Cue
identity, source text, sequence, and time range are stable; translation and
refinement values are the fields that may be updated.

## Model and SDK planning notes

- `gemini-3.5-transcribe-live` is the planned Live source transcription model;
  Google documents interim/final transcription, `customVocabulary`, Smart
  transcription, and automatic or hybrid VAD in [Live transcription](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe).
- `gemini-3.5-live-translate-preview` supports Live speech-to-speech
  translation and input/output transcription in [Live translation](https://ai.google.dev/gemini-api/docs/live-api/live-translate),
  but remains an optional future audio capability and is not the formal meeting
  text source in the target pipeline.
- `gemini-3.5-flash` is the planned non-Live backend model for translation and
  refinement workers; its structured-output support is documented in [Gemini 3.5 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash).
- The lockfile currently resolves `@google/genai` to `1.52.0`. A Phase 0
  compatibility check is required before implementation; this documentation
  update does not upgrade the SDK.

Current scope:

- Each user translation run creates one Session.
- The current session produces one selected target-language translation output.
- The Session preserves source transcript items for review and export.
- Saved Sessions are persisted through backend file storage by default under
  `DATA_DIR`; `SESSION_RECORDS_FILE` can override the exact path.
- Saved Session audio artifacts are persisted under `DATA_DIR/session-audio`;
  `SESSION_AUDIO_DIR` can override the exact directory.
- The same saved SourceTranscript can produce additional TranslationOutput
  records through re-translation without new audio input or re-recording.

## Goals

- Start and stop a Session from the browser.
- Show source-language transcripts in near real time.
- Preserve the source transcript as the canonical input for future translations.
- Keep `GEMINI_API_KEY` only on the backend.
- Avoid proxying audio streams through the backend.

## Non-Goals

- User accounts.
- Database-backed transcript history.
- Multi-user transcript history.
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
- Display of source transcript updates.
- A backend endpoint for ephemeral token issuance.
- Validation of supported target languages and token options.
- Session-local source transcript preservation for later export or review.
- Backend file-backed session history for saved transcript re-translation.

## Functional Requirements

- The user can select one supported target language before starting a session.
- The user can select one supported primary input language before starting a
  session. This is a soft context hint and does not block mixed-language speech.
- The default target language is English (`en`).
- The default primary input language is Traditional Chinese (`zh-Hant`).
- The user can start a live translation session.
- The browser requests microphone permission before streaming audio.
- The browser streams microphone audio to Gemini Live API while the session is
  active.
- The app displays source transcript updates.
- The user can stop the session.
- Stopping a session closes microphone tracks and ends the Gemini Live session.
- Before starting a session, the user can choose whether to locally record the
  speaker's original microphone audio.
- After stopping a session, the user can download saved original microphone
  audio from the Translation History detail view when the audio artifact was
  produced and successfully stored.
- Saved translation history details can download persisted original and
  translated WAV audio artifacts when those artifacts were produced and
  successfully stored.
- The app shows recoverable errors and allows the user to retry.
- The backend rejects unsupported target languages.
- The backend never exposes `GEMINI_API_KEY` to the browser.
- A Meeting can be created and configured before recording. The creator can set
  its name, source/target languages, meeting glossary, translated-audio
  playback, and original-audio recording settings in the independent Meeting
  Settings page before generating a Viewer entry link and QR code; opening the
  link does not request a
  microphone or create a live Session until the user explicitly starts
  recording.
- Active recording Sessions do not expose a control for creating new shares.

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
2. The user selects a primary input language or keeps `zh-Hant`.
3. The user selects a target language or keeps the default `en`.
4. The user clicks start.
5. The browser requests microphone permission.
6. The frontend requests an ephemeral token from `POST /api/live-token`.
7. The frontend connects directly to Gemini Live API with the ephemeral token.
8. The browser sends microphone audio chunks to Gemini.
9. Gemini returns translated audio and transcript events.
10. The frontend plays translated audio and updates transcripts.
11. The user clicks stop.
12. The frontend closes the Gemini session and stops microphone tracks.

Meeting share flow:

1. The user opens Meeting Management and creates a Meeting draft.
2. The user sets the meeting name, source/target languages, and meeting glossary.
3. The user saves the settings and generates a Viewer entry link and QR code.
4. A recipient opens the Viewer entry link and reads the meeting output.
5. Recording is started from the authenticated Live workspace.
6. Only then does the backend activate the Meeting, create the first Session, and the browser request
  microphone access and connect to Gemini Live API.

Meeting creation and editing use a dedicated settings route and layout. The
settings page is separate from the Meeting Management list and automatically
creates a permanent Viewer share after a new Meeting is saved.
Share creation retries up to three times; a failed share does not roll back the
saved Meeting.

Meeting settings may be edited after sharing. If recording is active, a language
or glossary change takes effect at the next Segment boundary by stopping the
current Live session and starting a new Segment with the updated settings.

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
Default primary input language: `zh-Hant`.

## Future Enhancements

- Persist transcript history.
- Add user accounts.
- Support shared rooms or multi-user sessions.
- Add text input translation.
- Add downloadable transcript exports.
- Add configurable voices or playback settings.
- Add usage metrics and operational dashboards.
- Add broader browser compatibility testing.
- Reopen a saved Session and generate additional TranslationOutput records from
  the same SourceTranscript without re-recording audio.
