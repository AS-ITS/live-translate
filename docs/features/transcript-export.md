# Transcript Export

Issue #41 Cutover in the current development branch supersedes the older Cloud Export flow below: the Host reads final Cues and raw/translated audio from local IndexedDB/OPFS after Reload. TXT/SRT/VTT and audio download remain on the Host; new Cloud Export requests and historical cloud download routes return `410 meeting_content_local_only`. Historical cloud rows are retained for a separate controlled cleanup.
Meeting Detail uses meeting metadata and Host local Cues for transcript and export; it does not poll retired Session Detail or Translations content endpoints.

Status: Cue-backed Session export implemented (WP5A); P7 cloud lifecycle and P8 cloud-only path completed

P7 adds the Supabase cloud lifecycle for Meeting exports. Cloud TXT, SRT, and VTT
exports are server-canonical and asynchronous. The API reads persisted Final
Cues first, falls back to persisted transcript items when no Final Cues exist,
stores the result in the private `meeting-exports` bucket, and exposes only a
60-second signed download URL. When the recording browser has IndexedDB Final
Cues for same Meeting, completed Meeting detail browser TXT/SRT/VTT export
use those durable local Cues first. Cloud export remains the fallback when
local Cues unavailable.

The export artifact key is `(owner_user_id, meeting_id, source_hash, format,
stream)`. Repeating a request for the same source is idempotent. `queued` and
`processing` artifacts are polled by the cloud UI every two seconds for up to
60 seconds; `failed` and `stale` artifacts can be retried without exposing
storage paths or transcript text in logs.

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

For persisted Sessions and Meetings with final `cues`, TXT, SRT, and VTT exports
use the same normalized Cue list: final-only filtering, cueId de-duplication,
sequence ordering, session-relative timeline validation, and export-time
language-aware wrapping. Partial Cues are never exported. Refined source and
translation values are the default when available; the UI can explicitly
choose the raw values. Both variants preserve identical Cue numbers and time
windows.

Meeting detail exports use persisted `finalCues` as the canonical subtitle
source. This keeps subtitle text and time windows stable after reload and avoids
exporting each durable transcript chunk as a separate flashing subtitle. Older
Meetings without persisted Cues retain a conservative transcript fallback that
groups adjacent fragments until sentence punctuation or a clear pause.

Meeting audio download controls are rendered only for successfully stored audio
artifacts. If neither original nor translated audio is available, the detail
page shows an explicit no-audio message instead of disabled download controls.

When an older Session, Meeting, or re-translation has no persisted Cues,
timed export derives one shared set of Cue windows from the source transcript
and distributes translation text across those windows. If no source timing is
available at all, the legacy item-timing fallback remains available because
there is no reference timeline from which alignment can be derived.

SRT/VTT timing is approximate frontend observation timing, not media-aligned
timing. Subtitle cues are derived from when transcript items are observed and
finalized in the browser.

## 2. Goals

- Export transcript content in TXT, SRT, and VTT formats.
- Use the transcript item model produced by `src/lib/transcript.js`.
- Preserve transcript ordering by `sequence`.
- Support source and translated transcript streams.
- Export only persisted Final Cues when available, with the persisted
  transcript-item fallback for older records.
- Prefer refined Cue values by default and support explicit raw export.
- Handle missing timing data gracefully.
- Keep export behavior deterministic and unit-testable.
- Preserve the existing Start / Stop flow.
- Use the P7 server-canonical export lifecycle for every supported transcript
  download.
- Add no real Gemini API dependency for validation.

## 3. P7 Cloud API

Owner-only endpoints are available in Supabase cloud mode:

- `POST /api/meetings/:meetingId/exports` with `{ "format": "txt", "stream": "translation" }` returns `202` for a queued artifact.
- `GET /api/meetings/:meetingId/exports` lists artifact metadata.
- `GET /api/meetings/:meetingId/exports/:exportId` returns one artifact status.
- `POST /api/meetings/:meetingId/exports/:exportId/download-url` returns a 60-second signed URL only when ready.
- `DELETE /api/meetings/:meetingId/exports/:exportId` removes the Storage object before metadata.

Timed formats do not accept `stream: "both"`. The shared `export_jobs` PGMQ
worker uses the existing visibility timeout, retry, and dead-letter behavior.
Meeting deletion stops if export Storage cleanup fails.

## 4. P8 Cloud-only path (historical)

P8 used the cloud export lifecycle for Meeting detail downloads. Issue #41
replaces that panel's source with Host local Cues as described below. The
server endpoints remain available for compatibility.

## 5. Non-Goals

- Translation history.
- Session history persistence.
- Database storage.
- Migrating existing local JSON or audio data into Supabase.
- User accounts or access-control changes.
- Editing transcript text before export.
- Exporting raw audio.
- Speaker diarization.
- AI summaries.
- Changing Gemini Live API session behavior.

- Calling the real Gemini API in tests.

## Issue #41 local Meeting export

The Meeting detail export panel now downloads TXT, SRT, and VTT from Cues read from this Host browser's IndexedDB. Original audio downloads require a local OPFS artifact. When local content is absent, the panel shows an unavailable state and does not fall back to the cloud export API. Legacy cloud export endpoints remain for historical compatibility; lifecycle v2 Meeting reads and queued Worker jobs are rejected before cloud Cue reads or artifact writes. Reload export of translated audio is not yet available.

## 6. Export Formats

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
- Source SRT export groups adjacent source transcript fragments into
  sentence-like cues until sentence-ending punctuation, a clear pause, or the end
  of the stream because source recognition may finalize in smaller fragments
  than translated output.
- Translation SRT export should reuse source cue timing when source cues are
  available and split translation text deterministically across those cue
  windows. Translation splitting should prefer sentence and phrase punctuation,
  preserve repeated short phrases such as `123, 123,`, and fall back to
  whitespace or length only when punctuation is insufficient. Source and
  translation exports must use the same resulting Cue windows.
- Subtitle cue text should normalize repeated whitespace and remove spacing
  between CJK characters or adjacent CJK punctuation without changing normal
  English or number spacing.
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
- Use the same source-fragment grouping policy as SRT for source VTT export.
- Use the same source-aligned translation and subtitle spacing policy as SRT.
- Format cue timestamps as `HH:MM:SS.mmm`.
- Avoid metadata blocks or styling until a concrete need is selected.

Example shape:

```text
WEBVTT

00:00:01.000 --> 00:00:03.000
Bonjour.
```

## 6. User Flow

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

## 7. Transcript Data Dependency

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

## 8. UI Behavior

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

## 9. Error Handling

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

## 10. Testing Requirements

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

## 11. Acceptance Criteria

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
