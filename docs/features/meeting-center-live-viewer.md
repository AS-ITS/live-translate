# Meeting Center and Live Viewer

## Status

Specification only. This document defines the implementation boundary for
issue #29; it does not mean that the capability is implemented.

## Capability Overview

Issue #29 consolidates the product around a Meeting as the only user-facing
work unit. The Meeting Management list is the application home, and a Meeting
Workspace contains live subtitles, glossary, sharing, export, and completed
translation history.

The capability extends the existing Meeting, MeetingSegment, Final Cue,
checkpoint, opaque share, QR code, short-code, and SSE foundations. It does not
change the browser-to-Gemini Live connection, ephemeral token flow, Recorder
lease model, or security model.

## Goals

- Make the Meeting list the application home.
- Keep all Meeting operations inside one Meeting Workspace.
- Separate global glossary entries from Meeting-private entries.
- Let a Viewer read the complete bilingual Cue stream through a Meeting share.
- Broadcast finalized Cues without waiting for checkpoint persistence.
- Restore missing Cues after Viewer reconnect without duplicates or reordering.
- Define a repeatable local measurement for Viewer display latency.

## Non-Goals

- Login, OAuth, RBAC, or multi-user identity.
- Database migration or a new storage engine.
- Cross-process event brokers or durable event replay.
- Proxying audio or changing the Gemini Live integration.
- A new automatic reconnect policy for Recorder sessions.
- Deleting existing re-translation data or historical outputs.
- Deployment automation or production monitoring infrastructure.

## User Experience

### Meeting Management home

The home route displays only the Meeting Management list. The left-side feature
navigation is removed; the product name remains in the top Header.

The list uses the existing AG Grid Community implementation and provides:

- Meeting name.
- Display status: in progress, paused/resumable, or completed.
- Source and target languages.
- Start time and last update time.
- Name search and status filtering.
- A status-appropriate action: open live subtitles, continue Meeting, or view
  translation history.

The persisted `interrupted` Meeting status is presented as paused/resumable;
no additional persisted status is introduced solely for the display label.

### Meeting Workspace

The Workspace is opened with a Meeting identifier and uses top-level tabs:

| Meeting state | Visible tabs | Default tab |
| --- | --- | --- |
| `active` | Live Subtitles, Meeting Glossary, Share Viewer, Export | Live Subtitles |
| `interrupted` | Live Subtitles, Meeting Glossary, Export | Live Subtitles |
| `completed` | Export, Translation History | Translation History |
| `created` | Live Subtitles, Meeting Glossary | Live Subtitles |

The existing live Cue renderer, checkpoint flow, export flow, and completed
Meeting detail remain the implementation foundations for their respective tabs.
The old independent navigation entries for live translation, translation
history, glossary, and re-translation are removed. Existing persisted
re-translation data remains readable by the backend and data model, but no
re-translation UI or route is exposed.

Proposed SPA routes are:

- `#meetings`
- `#meeting-workspace?meetingId=<id>`
- `#viewer?token=<token>`
- `#viewer?code=<shortCode>`

The old independent routes are not redirected and are not compatibility entry
points.

## Glossary Boundaries

Global glossary entries remain managed by the existing glossary capability.
Meeting-private entries belong only to one Meeting and are stored with the
Meeting settings and each Segment settings snapshot.

The Meeting settings shape gains a private collection:

```js
{
  privateGlossaryEntries: [
    {
      source: "專案代號",
      translations: { en: "Project Codename" },
      replacementAliases: { en: ["代號"] }
    }
  ]
}
```

Rules:

- Private entries never appear in the global glossary list.
- Editing a private entry never updates the global glossary repository.
- A private entry is visible only in its owning Meeting and its snapshots.
- Live translation applies selected global entries and Meeting-private entries.
- Completed Meetings are read-only.
- Viewer payloads do not expose glossary contents.

The existing Meeting glossary snapshot behavior remains the source of truth for
later Segments, reconnects, exports, and historical reads.

## Meeting Viewer Sharing

Viewer shares are Meeting-scoped while retaining the existing opaque token,
short-code, expiry, revocation, and anonymous Viewer model.

Owner API contract:

- `GET /api/meetings/:meetingId/shares` lists active share metadata.
- `POST /api/meetings/:meetingId/shares` creates a Viewer share and returns the
  plaintext token and short-code URLs once.
- `DELETE /api/meetings/:meetingId/shares/:shareId` revokes a share.

Anonymous Viewer API contract:

- `GET /api/shared-meetings/:token` returns the sanitized Meeting snapshot.
- `GET /api/shared-meetings/code/:shortCode` resolves a short code.
- `GET /api/shared-meetings/:token/events` opens the Meeting SSE stream.
- `GET /api/shared-meetings/code/:shortCode/events` opens the short-code SSE
  stream.

Viewer detail contains the Meeting summary, ordered Segment metadata, and all
final bilingual Cues. It excludes API keys, ephemeral tokens, audio artifacts,
input-device metadata, Recorder grants, leases, and glossary contents.

The Viewer is strictly read-only. It never requests a microphone, creates a
Live Session, claims a Recorder lease, or writes a Session/checkpoint.

## Cue Broadcast Contract

Final Cue delivery is intentionally separate from persistence:

```text
final bilingual Cue
  -> normalize and finalize in Recorder path
  -> publish Meeting cue event immediately
  -> update Viewer
  -> persist checkpoint/transcript/audio independently
```

The process-local Meeting broadcaster publishes an event shaped like:

```js
{
  eventId: 39,
  type: "cue.append",
  meetingId: "meeting-1",
  segmentId: "segment-2",
  cue: {
    cueId: "cue:session-1:segment-2:39",
    sequence: 39,
    status: "final",
    sourceText: "確認的原文。",
    translatedText: "confirmed source text.",
    startTimeMs: 1000,
    endTimeMs: 2800
  }
}
```

The event stream has a monotonically increasing Meeting-local event ID. The
initial REST snapshot includes a cursor containing the latest event ID and Cue
sequence.

The broadcaster must not await checkpoint writes, transcript persistence, audio
uploads, or unrelated background work before notifying Viewers.

## Viewer Ordering and Reconnect

The Viewer uses `cueId` as the idempotency key and orders Cues by Segment
sequence followed by Cue sequence. A newer version may replace the same Cue;
a stale version cannot overwrite a newer one.

Reconnect behavior:

1. Detect the SSE disconnect.
2. Fetch the current Meeting snapshot.
3. Merge the snapshot by Cue ID and ordered sequence.
4. Reconnect to SSE with the latest cursor when supported.
5. Apply new events through the same deduplication and ordering rules.
6. Refetch the snapshot if a sequence gap is detected.

The Viewer follows the latest Cue by default. Manual upward scrolling disables
automatic scrolling and shows a “back to latest” action. A new Cue does not
force scrolling while follow mode is disabled.

Long Meetings use a fixed-height windowed or equivalent segmented renderer so
that all historical Cues remain available without rendering every row at once.

## Latency SLA

The measured interval begins when a finalized bilingual Cue is ready for
broadcast and ends when the Viewer has rendered that Cue. Time waiting for
Gemini to produce a translation is excluded.

Acceptance targets under normal connectivity:

- P95 Viewer display latency is at most 2 seconds.
- Maximum display latency is at most 3 seconds.
- Persistence, audio upload, and checkpoint work cannot block broadcast.

The first validation is a local deterministic synthetic broadcaster test. Each
Cue records `producedAt`, `publishedAt`, `receivedAt`, and `renderedAt`. The
test covers continuous Cues, delayed persistence, reconnect, snapshot merge,
duplicate events, and sequence gaps. It does not call Gemini or overwrite a
full benchmark report.

## Delivery Phases

1. Meeting Management home, route consolidation, search, and status actions.
2. Meeting Workspace tabs and completed-history default behavior.
3. Global/private glossary data and UI isolation.
4. Meeting Viewer URL, QR, short code, complete Cue reading, and virtualized
   rendering.
5. Meeting Cue broadcast, reconnect gap recovery, latency instrumentation, and
   SLA tests.

Each phase must preserve existing recording, sharing, checkpoint, export, and
historical data behavior before the next phase begins.

## Security and Compatibility Constraints

- Never expose `GEMINI_API_KEY` or ephemeral tokens to Viewers.
- Preserve `/api/live-token` access gates, rate limits, and origin checks.
- Preserve Recorder lease, grant, and fence-token validation.
- Preserve share expiry and revocation.
- Sanitize Viewer DTOs at the backend boundary.
- Do not delete existing share, transcript, checkpoint, or re-translation data.
- Keep the broadcaster process-local for this capability; multi-process delivery
  is a future design.

## Acceptance Matrix

- Home shows only the Meeting Management list and no left navigation.
- A Meeting opens the correct Workspace and tab set for its status.
- Live subtitles, glossary, export, and translation history are no longer
  independent sidebar pages.
- Completed Meetings open complete historical Cue content.
- Global and private glossary entries are fully isolated.
- Viewer links, QR codes, short codes, and revocation work at Meeting scope.
- Viewer displays all historical Cues, follows latest by default, and can return
  to latest after manual scrolling.
- Viewer reconnect restores missing Cues with no duplicate, omission, or
  reordering.
- Local deterministic latency validation meets P95 ≤2 seconds and maximum ≤3
  seconds.
- Existing Recorder, share, checkpoint, export, and historical data flows do
  not regress.

## Out of Scope for This Specification Phase

No production code, API implementation, schema migration, test implementation,
real Gemini call, full benchmark, login, database, deployment change, or
cross-process event infrastructure is included in the specification phase.
