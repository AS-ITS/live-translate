# Better Transcript Handling

Status: Implemented / Completed

## 1. Feature Overview

Better Transcript Handling is the first completed Phase 2 feature. Its purpose
is to improve how the frontend handles source transcript and translated
transcript events from the Gemini Live session.

The feature should prevent duplicate append behavior, out-of-order display, and
final transcript text being overwritten by later partial updates. It should also
define a stable frontend transcript item model that future transcript export and
translation history features can reuse.

This feature is frontend-scoped planning. It must preserve the existing Start /
Stop flow, avoid backend/API changes, avoid persistence, and avoid real Gemini
API calls in automated validation.

## 2. Goals

- Maintain source transcript and translated transcript separately.
- Support partial transcript updates.
- Support final transcript retention.
- Avoid repeatedly appending the same partial transcript text.
- Ignore empty transcript events.
- Establish a stable transcript item shape.
- Preserve the existing Start / Stop flow.
- Add no new API.
- Add no persistence.
- Do not call the real Gemini API.

## 3. Non-Goals

- Transcript export.
- Translation history.
- Session history persistence.
- Database.
- Backend API.
- Gemini token flow changes.
- UI appearance changes.

## 4. Transcript Item Model Draft

The transcript model should be a frontend-only structure used to normalize SDK
events before they are rendered. It should support both live display and future
export/history work without requiring persistence in this feature.

Draft shape:

```js
{
  id: "transcript-item-id",
  stream: "source",
  status: "partial",
  text: "Recognized or translated text",
  sequence: 1,
  startedAt: 1234567890,
  finalizedAt: undefined,
  languageCode: "en"
}
```

Fields:

- `id`: Stable frontend identifier for one transcript item.
- `stream`: `"source"` for input transcript or `"translation"` for translated
  transcript.
- `status`: `"partial"` for the current in-progress item or `"final"` for
  committed transcript text.
- `text`: Normalized transcript text.
- `sequence`: Monotonic frontend sequence number used for stable ordering.
- `startedAt`: Frontend timestamp in milliseconds when the item is first
  observed.
- `finalizedAt`: Optional frontend timestamp in milliseconds when the item is
  committed as final.
- `languageCode`: Optional language metadata if available from the SDK event.

Recommended in-memory state:

```js
{
  source: {
    finalItems: [],
    currentPartial: null
  },
  translation: {
    finalItems: [],
    currentPartial: null
  },
  nextSequence: 1
}
```

### Fallback Strategy

If the SDK event does not expose a reliable partial/final flag:

- Treat events as partial while the session is active.
- Replace the stream's `currentPartial` instead of appending repeated partial
  text.
- Commit `currentPartial` to final only when the SDK provides an explicit final
  marker, a reliable segment boundary, or a session-end policy is selected.
- Do not finalize or split a short transcript merely because it ends with
  punctuation; punctuation remains part of the current segment until an
  explicit provider boundary, final marker, or session-end policy.
- When a live provider sends a shorter suffix of the active cumulative text,
  treat it as a duplicate update for the same segment. After a boundary, the
  same text remains valid as a new utterance.
- If no final signal exists, keep the display behavior conservative and do not
  fabricate precise final timestamps.
- After 1200ms without a new transcript event, resolve the active Cue by idle
  policy: paired source/translation text becomes final; source-only text gets
  one same-session retranslation attempt and then remains source-only final if
  that attempt produces no translation; translation-only text is discarded.
- Idle timers are versioned by Cue id and `updatedTimeMs`, and are cancelled by
  new transcript events, Pause, Stop, reconnect, and Segment rollover.
- Document the unresolved SDK behavior before enabling export/history features
  that depend on final transcript items.

## 5. Event Handling Rules

### Stream Routing

- Input/source transcript events must update only the `source` stream.
- Output/translated transcript events must update only the `translation` stream.
- Unknown transcript stream types should be ignored or mapped only after the SDK
  event contract is confirmed.

### Empty Text

- Trim incoming transcript text for validation.
- Ignore events whose text is empty after trimming.
- Empty events must not clear existing final items.
- Empty events must not replace a non-empty current partial item.

### Partial Events

- A partial event updates the stream's `currentPartial`.
- If no `currentPartial` exists for that stream, create one with a new `id`,
  `sequence`, `startedAt`, and `status: "partial"`.
- If a `currentPartial` already exists, replace its `text` with the latest
  partial text instead of appending a new item.
- Preserve the original `id`, `sequence`, and `startedAt` while updating the
  current partial.
- If the incoming partial text is identical to the current partial text, keep the
  state unchanged.

### Final Events

- A final event commits transcript text into the stream's `finalItems`.
- A committed final item must use `status: "final"` and a `finalizedAt`
  timestamp.
- If a matching `currentPartial` exists, the final event should update that item
  to final, move it into `finalItems`, and clear `currentPartial`.
- If no matching `currentPartial` exists, create a new final item with a new
  `id`, `sequence`, `startedAt`, and `finalizedAt`.
- Final items must not be overwritten by later partial events.
- Cumulative transcript updates must not append suffix fragments such as `3`
  after an active `123` item; independent post-boundary repeated speech remains
  a separate item.

### Matching Partial to Final

- Prefer explicit SDK segment identifiers if available.
- If no segment identifier exists, match by stream and current partial state.
- If final text equals or supersedes the current partial text, finalize the
  current partial.
- If final text appears unrelated to the current partial, commit the final item
  separately and clear the partial only if the SDK event contract confirms that
  final events close the current partial segment.

### Duplicate Text

- Identical partial text for the same stream should not create a new item.
- Identical final text should not be appended twice if it matches the last final
  item in the same stream and arrives within the same segment context.
- Exact duplicate detection should be stream-local. Source and translation text
  must not be compared against each other.
- Avoid broad fuzzy matching until real SDK event behavior is confirmed.

### Out-of-Order Events

- Use frontend `sequence` values for render ordering.
- Do not reorder already committed final items unless the SDK provides explicit
  reliable sequence or timestamp metadata.
- If an older partial arrives after a final item for the same stream and segment,
  ignore the older partial.
- If the SDK provides event timestamps or segment indexes, prefer those for
  detecting stale events once confirmed.
- Without SDK ordering metadata, favor stable display over aggressive correction.

## 6. UI Behavior

- Source transcript and translated transcript should remain visually separated
  in their existing transcript areas.
- Partial transcript text should appear as the current in-progress line for its
  stream.
- Final transcript text should remain visible after it is committed.
- Final transcript text must not be replaced by later partial transcript events.
- Partial transcript text may be replaced in place as newer partial events
  arrive.
- Render completed items as an ordered, accumulating history. Render the one
  current partial separately at the bottom with an in-progress label.
- Source and translation histories and current partials are rendered from their
  own stream state; completing one stream must not clear the other's history.
- Empty transcript events should cause no visible change.
- Stopping a session should keep the current transcript visible on the screen,
  matching the current demo expectation unless implementation review shows the
  existing behavior is different.
- Restarting a session should clear the transcript if the current app behavior
  clears session-local transcript state on new session start.
- This feature should not change the UI layout, styling, controls, or visual
  design.

## 7. Testing Requirements

Planned unit tests should cover deterministic transcript state behavior without
calling the real Gemini API.

Required unit test cases:

- Append final transcript.
- Update partial transcript.
- Partial followed by final.
- Ignore empty transcript.
- Keep source and translation separate.
- Preserve ordering.
- Avoid duplicate append.
- Restart session clears transcript if current behavior requires it.

Suggested assertions:

- A partial event creates or updates `currentPartial` without appending to
  `finalItems`.
- Repeated partial text does not change item count.
- A final event moves the matching partial into `finalItems`.
- A later partial event does not mutate existing final text.
- Source events never mutate translation state.
- Translation events never mutate source state.
- Sequence numbers increase only when a new transcript item is created.

## 8. Implementation Notes

Actual implementation locations:

- `src/lib/transcript.js` for deterministic transcript state operations.
- `src/lib/liveSession.js` event mapping from Gemini SDK events into normalized
  transcript events.
- `src/main.jsx` state handling for rendering source and translation transcript
  state.
- `tests/unit/transcript.test.js` for transcript behavior coverage.

Passed validation:

```bash
node --test tests/unit/transcript.test.js
```

Implementation guidance:

- Keep transcript logic in a small deterministic utility where possible.
- Keep SDK-specific event mapping separate from transcript state updates.
- Preserve the current Start / Stop session lifecycle.
- Do not add storage, backend endpoints, or export behavior in this feature.
- Do not call the real Gemini API in tests.

## 9. Risks / TODO

- TODO: confirm actual Gemini Live transcript event payload.
- TODO: confirm whether SDK exposes partial/final flag.
- TODO: confirm whether input/output transcript events include language
  metadata.
- SDK events may not include segment IDs, which makes exact partial-to-final
  matching less reliable.
- If timestamps are frontend-generated, they are suitable for ordering and UI
  behavior but not necessarily accurate subtitle timing.
- Transcript handling changes could affect visible Phase 1 behavior, so the
  existing Start / Stop flow must remain unchanged.

## 10. Acceptance Criteria

- Source and translation transcripts are maintained separately.
- Partial transcript events do not repeatedly append duplicate text.
- Final transcript text is retained and is not overwritten by later partial
  events.
- Empty transcript events are ignored.
- Existing Start / Stop flow is unchanged.
- Unit tests pass for transcript handling behavior.
- No backend changes.
- No API changes.
- No database or persistence changes.
- No real Gemini API calls are required for validation.
