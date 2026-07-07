# Transcript Export

Status: Minimal current-session export implemented

## 1. Feature Overview

Transcript Export is a Phase 2 planning feature that lets an internal user
download transcript content from the current or previously selected translation
session.

The current minimal implementation builds on the existing frontend transcript
item model from `src/lib/transcript.js`. It exports deterministic text files
from available current-session transcript items without changing the Gemini Live
session, token flow, backend API, storage model, or production authentication
behavior.

This feature does not add a backend endpoint, persistence, or real Gemini API
validation.

SRT/VTT timing is approximate frontend observation timing, not media-aligned
timing. Subtitle cues are derived from when transcript items are observed and
finalized in the browser.

## 2. Goals

- Export transcript content in TXT, SRT, and VTT formats.
- Use the transcript item model produced by `src/lib/transcript.js`.
- Preserve transcript ordering by `sequence`.
- Support source and translated transcript streams.
- Export only available transcript text; do not require persistence.
- Handle missing timing data gracefully.
- Keep export behavior deterministic and unit-testable.
- Preserve the existing Start / Stop flow.
- Add no real Gemini API dependency for validation.

## 3. Non-Goals

- Translation history.
- Session history persistence.
- Database storage.
- Backend-owned export endpoint.
- User accounts or access-control changes.
- Editing transcript text before export.
- Exporting raw audio.
- Speaker diarization.
- AI summaries.
- Changing Gemini Live API session behavior.
- Calling the real Gemini API in tests.

## 4. Export Formats

### TXT

TXT export should provide a readable plain-text transcript. It should be the
lowest-risk export format because it does not require reliable timing metadata.

Recommended behavior:

- Include source and translation sections when both streams are available.
- Preserve item order within each stream by `sequence`.
- Include only non-empty transcript text.
- Prefer final items when available.
- Include partial items only if the user exports during an active session and
  the UI clearly treats the file as an in-progress export.
- Use UTF-8 text.

Example shape:

```text
Source
Hello.

Translation
Bonjour.
```

### SRT

SRT export should produce subtitle cues from transcript items when timing data is
available or can be safely derived.

Recommended behavior:

- Export translated transcript items by default because subtitles usually target
  the translated audio or viewing language.
- Allow source export only if the UI exposes a clear stream choice.
- Use `startedAt` and `finalizedAt` from transcript items only as frontend
  timestamps, not precise media timings.
- If a cue is missing an end time, derive a conservative end time from the next
  item start or a short fallback duration.
- If timing quality is insufficient, disable SRT export or show a clear
  unavailable state instead of producing misleading subtitles.
- Format cue timestamps as `HH:MM:SS,mmm`.

Example shape:

```text
1
00:00:01,000 --> 00:00:03,000
Bonjour.
```

### VTT

VTT export should produce WebVTT cues for browser and media-tool workflows when
timing data is available or can be safely derived.

Recommended behavior:

- Start the file with `WEBVTT`.
- Use translated transcript items by default.
- Preserve transcript order by `sequence`.
- Use the same timing policy as SRT.
- Format cue timestamps as `HH:MM:SS.mmm`.
- Avoid metadata blocks or styling until a concrete need is selected.

Example shape:

```text
WEBVTT

00:00:01.000 --> 00:00:03.000
Bonjour.
```

## 5. User Flow

1. The user completes a translation session or has transcript text visible.
2. The user opens export controls from the transcript area.
3. The user chooses an export format: TXT, SRT, or VTT.
4. If stream selection is supported, the user chooses source, translation, or
   both where the format allows it.
5. The app validates that the selected export has enough transcript data.
6. The browser downloads a file with a clear session-oriented file name.
7. If export is unavailable, the UI explains the recoverable reason without
   clearing the transcript.

Current minimal UI:

- Supports current visible session transcript only.
- Lets the user choose TXT, SRT, or VTT.
- Lets the user choose Translation, Source, or Both.
- Disables download when the selected export has no transcript text.
- Disables SRT and VTT when Both is selected because timed formats export one
  stream at a time.
- Keeps transcript text available after Stop.

## 6. Transcript Data Dependency

Transcript Export depends on the transcript item model implemented in
`src/lib/transcript.js`.

Current item shape:

```js
{
  id: "source-1",
  stream: "source",
  status: "final",
  text: "Recognized or translated text",
  sequence: 1,
  startedAt: 1234567890,
  finalizedAt: 1234567990,
  languageCode: "en"
}
```

Relevant fields:

- `id`: Stable frontend identifier for one transcript item.
- `stream`: `source` or `translation`.
- `status`: `partial` or `final`.
- `text`: Exported transcript text after trimming and validation.
- `sequence`: Primary ordering field for export.
- `startedAt`: Frontend timestamp for item start or first observation.
- `finalizedAt`: Frontend timestamp for final commit.
- `languageCode`: Optional metadata that may be included later if needed.

Data rules:

- Export functions should accept transcript items rather than SDK events.
- Export functions should not mutate transcript state.
- Items should be filtered by stream before formatting.
- Items should be sorted by `sequence`.
- Empty or whitespace-only text should be ignored.
- Final items should be preferred for completed-session exports.
- Partial items should be handled only by an explicit in-progress export policy.
- SRT and VTT must treat `startedAt` and `finalizedAt` as approximate frontend
  timing until real segment timestamps are confirmed.

## 7. UI Behavior

- Export controls should appear near the transcript display or transcript action
  area.
- Export controls should remain disabled when no exportable transcript text is
  available.
- TXT should be available when at least one selected stream has text.
- SRT and VTT should be available only when the selected transcript items have
  usable timing or a documented fallback timing policy is implemented.
- The default export stream should be translated transcript when available.
- Source transcript export should be available only if the UI makes the stream
  choice clear.
- Exporting should not stop an active session.
- Exporting should not clear or modify transcript state.
- Export file names should be predictable, for example
  `live-translate-transcript-YYYYMMDD-HHMMSS.txt`.
- The UI should avoid adding broad layout or visual redesign as part of this
  feature.

## 8. Error Handling

- If no transcript text exists, show an unavailable state instead of downloading
  an empty file.
- If the selected format is unsupported, block export and show a stable
  recoverable error.
- If SRT or VTT timing is insufficient, disable the format or show a clear
  timing-related error.
- If browser download creation fails, keep transcript state intact and show a
  recoverable error.
- Export errors must not log transcript content unless explicitly approved.
- Export errors must not expose secrets, ephemeral tokens, or internal stack
  traces.

## 9. Testing Requirements

Tests should be deterministic and must not call the real Gemini API.

Run transcript export unit tests:

```bash
node --test tests/unit/transcriptExport.test.js
```

Unit test coverage:

- TXT formatting for source transcript items.
- TXT formatting for translated transcript items.
- TXT formatting for both streams when selected.
- SRT timestamp formatting with valid timing.
- VTT timestamp formatting with valid timing.
- Missing timing behavior for SRT and VTT.
- Empty transcript rejection.
- Whitespace-only transcript item filtering.
- Ordering by `sequence`.
- Partial item handling according to the selected in-progress export policy.
- Unsupported format rejection.
- File name generation if implemented in a utility.

E2E test coverage, if UI controls are implemented:

- Export button is disabled when transcript text is unavailable.
- User can download TXT from a mocked transcript session.
- SRT and VTT controls reflect timing availability.
- Export does not stop the active mocked session.

Integration tests are not required unless a backend export endpoint is selected
later.

## 10. Acceptance Criteria

- `docs/features/transcript-export.md` defines the Transcript Export feature
  scope.
- Export formats TXT, SRT, and VTT are specified.
- The spec depends on the `src/lib/transcript.js` transcript item model.
- The spec preserves current Start / Stop and Gemini Live session behavior.
- Current-session export is implemented in frontend code only.
- No backend API is added.
- No persistence is added.
- No package is installed.
- No real Gemini API call is required.
- Required testing expectations are documented.
