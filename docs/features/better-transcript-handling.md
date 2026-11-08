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

Live events feed both the transcript compatibility state and the subtitle Cue
state. Transcript items therefore retain `sessionId`, `liveSessionId`,
`segmentId`, `sourceLanguageCode`, and `targetLanguageCode` so the live UI can
identify whether a recovery item is already represented by a final Cue. Legacy
items with missing scope fields may use text matching, but explicit scope
mismatches must not match. Source-language conversion belongs to the display
boundary: `zh-Hans` remains Simplified Chinese, while the default and
`zh-Hant` display Traditional Chinese without mutating stored transcript text.

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
- Do not finalize a one-sided or short transcript merely because one provider
  event ends with punctuation; punctuation remains part of the paired Cue until
  both source and translation are complete enough to submit.
- When a live provider sends a shorter suffix of the active cumulative text,
  treat it as a duplicate update for the same segment. After a boundary, the
  same text remains valid as a new utterance.
- If no final signal exists, keep the display behavior conservative and do not
  fabricate precise final timestamps.
- A provider `isFinal` flag does not finalize a Cue by itself. Adjacent
  fragments stay in one pending buffer until both sides have a strong sentence
  ending, a turn/generation boundary has remained idle for the 700ms debounce,
  or the safe language limit requires a natural split. Short bilingual Cues
  without sentence punctuation may also merge across consecutive provider
  turns when they are within the adjacent-fragment time window.
- Chinese Cues use a 12-character minimum when deciding whether to finalize
  immediately, so short fragments are normally merged with following text;
  once a paired Cue has been idle for the debounce window, it is finalized even
  when the utterance is short, preventing a completed utterance from remaining
  permanently partial.
- Resolve a paired active Cue by idle policy after the 700ms debounce, using the
  provider boundary when available and the latest Cue text update when no
  boundary is provided. Translation-only text is discarded.
- Idle timers are versioned by Cue id and `updatedTimeMs`, and are cancelled by
  new transcript events, Pause, Stop, reconnect, and Segment rollover.
- Transcript events that arrive after a provider turn boundary may revise the
  same active/finalized Cue when they are cumulative extensions within the
  existing revision window; unrelated later turns remain separate.
- The latest finalized Cue remains revisable for 5000ms. A late source or
  translation fragment may monotonically merge into that same Cue id, sequence,
  persistence record, and checkpoint.
- Matching `audioTurnId` and arrival inside the 5000ms revision window provide
  context but are not sufficient proof that an event revises the same Cue. The
  event must also be a valid cumulative update, late counterpart, terminal
  replay, or authoritative late final. Independent complete utterances remain
  separate even when their text and `audioTurnId` match.
- Adjacent final bilingual Cues in the same Segment are coalesced when neither
  Cue has reached sentence punctuation and they arrive within the adjacent
  fragment window, including when one or both Cues were finalized after a
  provider turn boundary. Cue identity stays anchored to the first Cue, while
  its end time extends to the latest merged fragment. The engine does not split
  a Cue solely because it exceeds a language-specific character limit.
- Final Cues with Arabic-digit content are checked by comparing the ordered
  digit sequence in the source and translation. A mismatch such as source
  `4點50分` and translation `4:00 PM` schedules one same-session correction;
  the correction replaces the translation on the original Cue and its audio is
  not played a second time.
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
- History-prefix removal applies only to non-final cumulative updates. A final
  provider event is treated as a complete turn, even when its text begins with
  the same numbers or phrases as earlier final items.

### Matching Partial to Final

- Prefer explicit SDK segment identifiers if available.
- If no segment identifier exists, match by stream and current partial state.
- If final text equals or supersedes the current partial text, finalize the
  current partial.
- If final text appears unrelated to the current partial, commit the final item
  separately and clear the partial only if the SDK event contract confirms that
  final events close the current partial segment.

### Duplicate Text

- Text equality is not an event deduplication key. Independent final events with
  identical text remain independent utterances.
- Replay deduplication requires the same stable event or revision identity and
  remains stream-local. Source and translation text must not be compared against
  each other.
- A cumulative partial snapshot may replace the previous partial for the same
  stream identity; an unrelated identical event must not be collapsed into it.
- Glossary correction preserves every required-target occurrence already emitted
  by the provider. It may remove a known ordinary-translation alias only when
  locally adjacent to the corresponding required target; it must not globally
  delete repeated target text or infer missing repetitions from source counts.
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
- A paired partial Cue is finalized after the idle debounce when no newer
  transcript event arrives. A source-only partial that remains unresolved after
  bounded retranslation retries is removed from the live preview so it cannot
  remain indefinitely labelled as recognizing/translating; the canonical
  transcript item remains preserved separately.
- Meeting reload and resume restore all persisted Segment transcript chunks. UI
  caching must not discard older Segments or hide saved transcript content when
  later Segments already contain final Cues.
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

## 11. Spoken Turn Identity and Development Trace

`turnComplete` and `generationComplete` describe the same provider boundary
when they arrive consecutively without intervening transcript text. The first
accepted boundary rotates the local `audioTurnId`; the second must not rotate it
again. Transcript text arriving after that boundary belongs to the new spoken
turn unless it is an actual late/cumulative continuation of one side of the
previous turn. Source and translation may therefore retain different active
turn identities while a late counterpart is completed.

Provider event IDs are deduplicated within a provider epoch. Reconnect and
rollover epochs must not collide with an earlier provider event carrying the
same ID.

An explicit server runtime flag, `LIVE_PIPELINE_TRACE_ENABLED=true`, exposes the
bounded browser-memory trace through:

```js
window.__liveTranslateDebug.getPipelineTrace(filter)
window.__liveTranslateDebug.getTurnTrace(audioTurnId)
window.__liveTranslateDebug.exportPipelineTrace()
window.__liveTranslateDebug.clearPipelineTrace()
```

## 12. Local Raw Translation Comparison

The raw translation comparison diagnostic is available only in local development or builds explicitly compiled with `LIVE_TRANSLATE_DIAGNOSTICS=true`. It stays disabled until manually enabled through `window.__liveTranslateDebug`.

Each provider event is recorded under one normalized event identity so provider raw source and translation can be compared with normalized, glossary-corrected, and Cue canonical translations. The Cue stage only observes the existing reducer result; it does not change Cue association, snapshot selection, merge behavior, or revision timing.

Records are allow-listed, kept only in browser memory, capped at 500 entries, and expire after 15 minutes. The diagnostic sends no network request and writes no server log or persistent storage. Disabling it clears all retained text. Production builds do not expose the API unless diagnostics were explicitly enabled at build time.

The browser reads only `{ livePipelineTraceEnabled }` from
`/api/runtime-config`; it never reads the server environment directly. The trace
covers microphone input, PCM capture/send, provider events, normalized
transcript events, Cue append/update/finalize/merge/drop, React render, and
paired Recorder/Viewer transport correlation. It remains in browser memory
after `recovery_failed` until reload or explicit `clearPipelineTrace()`. With
the flag disabled, the tracer retains and logs nothing and the full trace API
is not exposed. Production must keep the flag disabled.

## 13. Local Cue identity and revision (Issue #41 B2-A)

A Cue keeps its `cueId` across accepted changes; verified `segmentId` is separate and may remain null. New unknown-owner IDs use the existing `cue:<sessionId>:<sequence>` form. Reload allocation uses a sequence floor from local assigned and unassigned records plus Cue checkpoints. Recovered Cues are excluded from live turn matching, because local turn keys and text cannot prove a Provider retransmission after reload.

The synchronous Cue-state commit assigns revision 1 to a new Cue and increments it for changed Cue snapshots. Source, translation, and refinement versions retain their separate meanings. IndexedDB rejects stale or conflicting revisions for assigned and unassigned Cues; unversioned assigned records read as revision 0 until their first changed versioned write. Accepted partial and final unknown-owner Cues are saved in `unassignedCues`; reducer absorption updates the survivor and removes the loser in one transaction, retaining the allocation floor so reload cannot reuse the losing ID. Recovery restores partial Cues without pairing them to new Provider events. Refinement submissions and results must match the current Cue input hash before changing Cue state. B2-B promotion remains separate.

An intentionally dismissed provisional Cue keeps a revisioned marker in `unassignedCues`. Reload excludes that Cue from the visible state and still reserves its identity. Completed polling output may mark a Cue only when its recorded input hash matches the current Cue input.


For a same-turn late translation that changes `initialTranslation`, the pending refinement input reset is committed in the same translation mutation. The source version stays independent; stale side versions and cross-segment Cue identities remain rejected.

## 14. Local unassigned Cue export (Issue #41 B2-B)

Meeting detail reads assigned and unassigned Cues from local IndexedDB before enabling local TXT/SRT/VTT export. Only final, non-dismissed Cues enter the export source; unassigned Cues retain `segmentId: null`. Equivalent Cue identities export once. Conflicting revision, content, or ownership blocks export and shows a retryable error. A failed IndexedDB read also blocks export; meeting switches ignore late results from the previous Meeting.
