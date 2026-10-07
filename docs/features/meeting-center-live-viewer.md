# Meeting Center and Live Viewer

## Status

Issue #31 P3 is implemented for cloud deployments: original Segment audio
uploads directly from the browser to private Supabase Storage, and Meeting
Viewer receives database-persisted Final Cues through private Supabase
Realtime. Local development without Supabase keeps the WAV and SSE fallback.

Milestone 4 is implemented: Meeting Viewer shares now support Meeting-scoped
viewer links, short codes, QR entry, sanitized historical Cue snapshots, and a
windowed bilingual Cue renderer.

Milestone 3 is implemented: Meeting Management remains the canonical
application home and opens a status-aware Meeting Workspace with Live
Subtitles, Meeting Glossary, Export, and completed-history tabs. Global glossary
selections and Meeting-private glossary entries
are isolated; private entries are stored in Meeting and Segment snapshots and
are never included in Viewer payloads. Cue broadcast and reconnect recovery
remain planned for later delivery phases.

## Capability Overview

Issue #29 consolidates the product around a Meeting as the only user-facing
work unit. The Meeting Management list is the application home, with separate
Setting, Live, History Detail, and public Viewer pages.

The capability extends the existing Meeting, MeetingSegment, Final Cue,
checkpoint, opaque share, QR code, short-code, and SSE foundations. It does not
change the browser-to-Gemini Live connection, ephemeral token flow, Recorder
lease model, or security model.

## Goals

- Make the Meeting list the application home.
- Keep Setting, Live, History Detail, and public Viewer responsibilities separate.
- Separate global glossary entries from Meeting-private entries.
- Import CSV, JSON, or XLSX rows into Meeting-private glossary settings.
- Let a Viewer read the complete bilingual Cue stream through a Meeting share.
- Broadcast finalized Cues without waiting for checkpoint persistence.
- Restore missing Cues after Viewer reconnect without duplicates or reordering.
- Define a repeatable local measurement for Viewer display latency.

## Non-Goals

- Login, OAuth, RBAC, or multi-user identity.
- WebM-to-MP3 transcoding or translated-audio artifact generation.
- Replay of transient partial Cues; only persisted Final Cues are broadcast.
- Proxying audio or changing the Gemini Live integration.
- A new automatic reconnect policy for Recorder sessions.
- Deleting existing re-translation data or historical outputs.
- Deployment automation or production monitoring infrastructure.

## User Experience

Live Recorder 與 Viewer 共用同一套原文／翻譯顯示切換規則。兩個按鈕始終可操作；若使用者隱藏目前唯一可見的字幕，系統會同步顯示另一側，確保原文與翻譯不會同時隱藏。

### Meeting Management home

The home route displays only the Meeting Management list. The left-side feature
navigation and legacy Header feature menu are removed; the product name and a
single `＋ 建立會議` action remain in the top Header.

The list uses a responsive light card grid. AG Grid Community remains available
for other management views and is not removed from the frontend dependencies.
Each Meeting card provides:

- Meeting name.
- Display status: in progress, resumable, created, or completed. The persisted
  `interrupted` status is displayed as paused/resumable because the domain does
  not persist a separate `paused` state.
- Source and target languages, plus the last updated time.
- A concise status explanation backed only by the Meeting read model.
- Name search and status filtering.
- A status-appropriate single primary action: unfinished Meetings first open
  their settings for confirmation before live subtitles, while completed
  Meetings open translation history.

Cards are arranged in two columns on desktop and one column below 1024px. Created,
active, and interrupted Meeting cards open settings first; the settings page owns
the explicit transition to live subtitles. Completed cards open history. Each
primary button stops event propagation so it does not trigger card navigation twice.
Draft deletion remains in the Meeting settings danger zone rather than on the
card. The home route keeps only the product brand and the single `＋ 建立會議`
Header action; the existing search, status filter, and global glossary controls
remain in the toolbar.

### Independent Meeting pages

Setting owns Meeting creation/editing, glossary and audio settings, plus
Viewer share links and QR codes. Live owns recording and live Cue
controls. History Detail owns saved Meeting reading and export. The public
Viewer owns read-only historical and live Cue rendering through a Viewer share.
Completed Meeting actions open `#meeting-detail?meetingId=<id>&from=meetings`.

Translation History is no longer a standalone route. Completed Meeting actions
open the single Meeting record page at
`#meeting-detail?meetingId=<id>&from=meetings`.
The standalone Meeting record uses the same page-card shell as the Global
Glossary page; its page header owns the title and return action.
Existing persisted
re-translation data remains readable by the backend and data model, but no
re-translation UI or route is exposed.

Canonical SPA routes are:

- `#meetings`
- `#meeting-settings?mode=create`
- `#meeting-settings?mode=edit&meetingId=<id>`
- `#live?meetingId=<id>`
- `#meeting-detail?meetingId=<id>&from=meetings`
- `#viewer?token=<token>`
- `#viewer?code=<shortCode>`

The application uses independent Setting, Live, History Detail, and public
Viewer pages. Viewer share creation and QR code management remain in the
Meeting Settings page; its viewing URL opens in a new browser tab, and the
public Viewer is available without a Workspace login through
`#viewer?code=<shortCode>`.

Removed legacy hashes such as `#history`, `#retranslate`, `#live-recording`,
`#translation-history`, `#watch`, `#record`, and `#dead-letter-queue` safely
fall back to `#meetings`. Existing re-translation and DLQ data remains readable
by backend services and is not deleted. `#glossary` remains a supported entry
that opens the global glossary panel from Meeting Management.

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
- Global glossary list supports multi-select batch enable, disable, and confirmed delete actions; batch mutations reuse the existing entry APIs sequentially.
- Editing a private entry never updates the global glossary repository.
- A private entry is visible only in its owning Meeting and its snapshots.
- Live translation applies selected global entries and Meeting-private entries.
- Completed Meetings are read-only.
- Viewer payloads do not expose glossary contents.
- Meeting glossary imports are previewed without persistence and are saved with
  the existing Meeting settings request.

The existing Meeting glossary snapshot behavior remains the source of truth for
later Segments, reconnects, exports, and historical reads.

## Meeting Viewer Sharing

### Permission separation and stop window

A Viewer share is read-only. Its token or short code grants only the
sanitized Viewer snapshot and live updates; it cannot record, submit
Cue/checkpoint/operation/audio queue items, download audio, or create an
export. Host export is an independent authenticated capability and is never
inferred from a Viewer share or ordinary Viewer membership.

When the host stops a Meeting, or stale-recorder policy stops it, Viewer and
Recorder share access is revoked immediately and existing Viewers stop
receiving new Cues. The host retains a separate 30-minute window to export
TXT/SRT/VTT and download completed audio; after expiry content returns
`410 meeting_content_expired`.

Viewer shares are Meeting-scoped while retaining the existing opaque token,
short-code, expiry, revocation, and anonymous Viewer model.

Meeting access API contract:

- `GET /api/meetings/:meetingId/shares` lists active share metadata.
- Active meeting members may read and update ordinary Meeting settings, and may list or create Viewer shares.
- `POST /api/meetings/:meetingId/shares` creates a Viewer share and returns the
  plaintext token and short-code URLs once.
- `DELETE /api/meetings/:meetingId/shares/:shareId` remains restricted to the Meeting owner or `super_admin`.

Anonymous Viewer API contract:

- `GET /api/shared-meetings/:token` returns the sanitized Meeting snapshot.
- `GET /api/shared-meetings/code/:shortCode` resolves a short code.
- `POST /api/shared-meetings/:token/realtime-token` returns a five-minute
  Viewer JWT and private `meeting:<meetingId>` channel.
- `POST /api/shared-meetings/code/:shortCode/realtime-token` provides the same
  exchange for a short code.

Cloud audio uses metadata-only HTTP endpoints. The browser uploads WebM/Opus
with TUS directly to
`meeting-audio/<owner>/<meeting>/<segment>/recording.webm`. Completion verifies
the stored object; download requests perform ownership validation and return a
60-second signed URL. Audio bytes never cross the Vercel Function.

Viewer detail contains the Meeting summary, ordered Segment metadata, and all
final bilingual Cues. It excludes API keys, ephemeral tokens, audio artifacts,
input-device metadata, Recorder grants, leases, and glossary contents.

The Viewer is strictly read-only. It never requests a microphone, creates a
Live Session, claims a Recorder lease, or writes a Session/checkpoint.

## Cue Broadcast Contract

In cloud mode, persistence is the broadcast boundary:

```text
stable Cue with source or translation finalized
  -> validate Meeting/Segment/Session relationship
  -> upsert subtitle_cues
  -> database trigger broadcasts cue.append on a private Realtime channel
  -> Viewer merges by cueId/version
```

The database trigger publishes an event shaped like:

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
    sourceStatus: "finalized",
    sourceVersion: 1,
    translatedText: "",
    translationStatus: "pending",
    translationVersion: 0,
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

The initial snapshot returns the latest 100 Cues and an opaque cursor for
loading older pages. Each older page is merged by Cue ID without duplicates or
omissions. The Viewer uses `cueId` as the idempotency key and orders Cues by
Segment sequence followed by Cue sequence. A newer version may replace the same Cue;
a stale version cannot overwrite a newer one. Device snapshots and cloud events
carry validated Segment sequence. A live Cue without resolved Segment order stays
after ordered historical Cues. Source and translation versions merge independently.

Reconnect behavior:

1. Detect the SSE disconnect.
2. Fetch the current Meeting snapshot.
3. Merge the snapshot by Cue ID and ordered sequence.
4. Reconnect to SSE with the latest cursor when supported.
5. Apply new events through the same deduplication and ordering rules.
6. Refetch the snapshot if a sequence gap is detected.

The WebRTC fast path renews its signaling participant with an authorized `/join`.
Viewer join requests a fresh negotiation, Device maintains a targeted peer per
Viewer, and low-frequency discovery polling continues while channels are open.
Supabase Realtime token refresh and channel-failure reconnect use independent
timers. A `CHANNEL_ERROR`, `TIMED_OUT`, or `CLOSED` status cancels the current
generation's refresh timer, tears down that channel, and starts bounded
reconnect; late callbacks from an old generation cannot remove its replacement.
The Viewer keeps current Cues during recovery. A transient `disconnected` state receives
a five-second grace period; the Device then attempts ICE restart and rebuilds
the peer if recovery does not complete within ten seconds. Full reconnect uses
at most six attempts with jittered exponential delays capped at ten seconds.
Snapshot, Realtime, and SSE recovery classify stopped, revoked, and unauthorized
shares as terminal. Transient snapshot failures retry without clearing Cues;
retry exhaustion exposes a manual “重新連線” action.

DataChannel snapshot and replay envelopes may include `sourceId`. A Viewer asks
the same source to replay after its last received transport sequence. A changed
source starts from a snapshot. Replay older than retained history also returns
a snapshot. Cloud Cue publication continues while WebRTC is connected, allowing
snapshot and Realtime replay after a later outage. Cue merge remains authoritative by `cueId` and
source/translation/refinement versions, so a late snapshot cannot replace a
newer Cue.

The Viewer follows the latest Cue by default. Manual upward scrolling disables
automatic scrolling and shows a “back to latest” action. A new Cue does not
force scrolling while follow mode is disabled.

Long Meetings use a fixed-height windowed or equivalent segmented renderer so
that all historical Cues remain available without rendering every row at once.

## Latency SLA

DEV instrumentation records `audioTurnStartedAt`, `firstSourcePartialAt`,
`firstTranslationPartialAt`, `sourceFinalAt`, `translationFinalAt`,
`viewerFirstPublishedAt`, and `viewerTranslationUpdatedAt`. It reports Audio to
first source/translation and each finalized side to Viewer publication/update.

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
2. Independent Setting, Live, and History Detail page boundaries. **Completed.**
3. Global/private glossary data and UI isolation. **Completed.**
4. Meeting Viewer URL, QR, short code, complete Cue reading, and virtualized
   rendering. **Completed.**
5. Meeting Cue broadcast, reconnect gap recovery, latency instrumentation, and
   SLA tests. **Completed.**

Each phase must preserve existing recording, sharing, checkpoint, export, and
historical data behavior before the next phase begins.

## Short-lived retention behavior

Only successful Meeting completion starts one recording-wide 30-minute deadline;
all Sessions and rollover Segments in that recording share it. The database
sets and freezes `ended_at` and `purge_at`. Pauses, reconnects, rollovers,
interruption, and failed sessions do not start or extend it. Legacy rows without
a verified completion anchor are not bulk-deleted.

At expiry, recording content, Viewer snapshot/replay, new cues, checkpoint
writes, background output, and direct authenticated Storage access are rejected.
Meeting settings, members, glossary, and audit records remain. The UI separates
"錄製資料已到期" from "實體資料已清除". Local OPFS and IndexedDB copies are
checked on startup, foreground, every minute, and before reads/exports; a
crashed/closed browser cleans on next opening. An export started before expiry
may finish while its browser lock delays local deletion. Downloaded files are
outside application control.

There is no Supabase Cron, Vercel Cron, or external scheduler. Existing Meeting
GET requests opportunistically trigger a managed background batch: at most one
Meeting, 20 Storage objects or 50 database rows, with a persistent 15-second
cross-instance throttle and a short retryable claim. With no website/API
traffic, cloud physical data may remain past the 30-minute deadline until the
next relevant request; access is still denied at expiry. Storage objects are
removed through the official Storage API. A completed or expired Meeting can
still be manually deleted; only its owner or an active super-admin can retry a
completed deletion using the protected minimal tombstone.

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
- Meeting settings, Live recording, History Detail, and public Viewer are
  independent pages with explicit route boundaries.
- Share management is owned by Setting while Viewer is read-only.
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
