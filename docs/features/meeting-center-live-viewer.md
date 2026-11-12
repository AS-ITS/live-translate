# Meeting Center and Live Viewer

## 現行能力

Meeting Management 是應用程式的會議入口，提供設定、Live、History Detail 與 Viewer 頁面。新建 Meeting 的 PCM、音訊、Cue、Transcript、Checkpoint 與 Recovery 由 Host OPFS／IndexedDB 保存；Supabase 保存會議 metadata、字典、分享與授權。Viewer 透過分享連結取得授權後，經 WebRTC DataChannel 接收 Host 的即時字幕、快照與重播。Redis／Node.js API 協調 signaling。舊的 Supabase Realtime 與 Meeting SSE 字幕路徑已退役。

詳見[架構總覽](../architecture/architecture-overview.md)與[WebRTC 驗證契約](../verification/webrtc-browser-deployment.md)。


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

Viewer 全螢幕是 presentation-only state。穩定的 `viewer-fullscreen-shell` 包含 Header、QR 與字幕內容，WebRTC transport generation、PeerConnection、DataChannel、replay 或 snapshot 更新不得替換或重新掛載此 DOM。瀏覽器支援時使用原生 Fullscreen API，並以 `document.fullscreenElement` 及 `fullscreenchange` 同步 UI；API 缺席或拒絕時改用 fixed、dynamic viewport height 與 safe-area inset 的 CSS presentation mode，不承諾隱藏 iOS 瀏覽器工具列。reconnect 不得重設全螢幕、原文／翻譯顯示偏好或字幕 auto-follow／scroll state。原生全螢幕拒絕提示可手動關閉並在 5 秒後自動清除，新嘗試會先清除舊提示與 timer。

Viewer 提供小／中／大三段字幕字級，預設為中，並以 Viewer 專用 localStorage 偏好在重新整理、全螢幕切換與 Pause/Continue 後沿用。字級只影響原文與翻譯的同步視覺呈現；切換時沿用既有 Cue、連線、完整歷史與閱讀錨點，不得 remount Viewer 或強制回到最新字幕。

Viewer 初次載入與停留底部時自動跟隨最新 Cue。使用者向上捲動後，以穩定 `cueId` 保存閱讀錨點，snapshot/replay merge、Cue revision、高度變化、Pause/Continue、reconnect 與 fullscreen viewport 變化都不得強制捲到底部。歷史閱讀期間繼續接收並渲染 Cue，浮動控制以唯一 `cueId` 顯示未查看數量；手動回到底部或點擊控制後恢復 auto-follow。

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

### Dictionary correction contract

The existing Gemini Live instruction treats the active Meeting dictionary as required terminology. It prefers complete longer names, preserves repeated uses, and applies terms only to original source speech. Provider terms refresh at the next normal Segment boundary; local correction can refresh on a later Turn.

The Live Session debug snapshot records dictionary presence, effective entry count, whether the token prompt contains the active terms, source match and alignment candidate counts, correction status, and a reason code. These added diagnostic fields contain no meeting speech or translation text.

Build match candidates from the original, uncorrected text. Chinese terms use substring matching; English terms require word boundaries. Overlapping source matches choose the longest term, then emit non-overlapping matches in source order. Handle each source range once; never match replacement output again. Handle separate terms and repeated occurrences independently. Equal-range matches with different targets report `correction_ambiguous` and leave that range unchanged.

Gemini translation correction also requires a safely identifiable term or alias in the provider translation. Replace each aligned occurrence once. If fewer occurrences can be located than matched in the source, keep every safe local replacement, preserve all unmatched provider wording, and report `correction_uncertain`; never insert a missing target term. Partial and Final each recompute from uncorrected provider text. Preserve `rawTranslation`, provider provenance, and translation version. Correction must not create a Provider Event or an unauthorized Final Cue translation mutation. Viewer, reload, and TXT/SRT/VTT use the effective corrected Cue text.

## Meeting Viewer Sharing

### Permission separation and stop window

Viewer share tokens and short codes authorize sanitized metadata and Host DataChannel subtitles only. They do not authorize recording, Cue／Checkpoint writes, or Host-local audio export. Host export requires separate authenticated permission. A completed Meeting retains its existing 30-minute Host-local retention deadline; expiry rejects Viewer content access and Host export.


Viewer shares are Meeting-scoped while retaining the existing opaque token,
short-code, expiry, revocation, and anonymous Viewer model.

Meeting access API contract:

- `GET /api/meetings/:meetingId/shares` lists active share metadata.
- Active meeting members may read and update ordinary Meeting settings, and may list or create Viewer shares.
- `POST /api/meetings/:meetingId/shares` creates a Viewer share and returns the
  plaintext token and short-code URLs once.
- `DELETE /api/meetings/:meetingId/shares/:shareId` remains restricted to the Meeting owner or `super_admin`.

Viewer 授權 API 僅提供 Meeting metadata 與分享資訊。短碼可解析分享；字幕與快照由 Host WebRTC DataChannel 傳送。Viewer 不取得 Host 音訊、API key、短效 token、錄製租約或本機 Checkpoint。


The Viewer is strictly read-only. It never requests a microphone, creates a
Live Session, claims a Recorder lease, or writes a Session/checkpoint.

## Cue 傳遞契約

Host 在本機 Cue Writer 確認 Final Cue 後，經 DataChannel 向 Viewer 發送 append／update；Viewer 依 `cueId` 與版本合併。新連線取得 Host snapshot，重連時可依來源與序號 replay。Cue 發送不等待雲端 Cue、Checkpoint、音訊上傳或背景工作。


## Viewer Ordering and Reconnect

For Local-only rollover, Host sends `segment.transition` with local Segment ID, sequence, and `switching` or `ready` status over the existing DataChannel. Snapshot and replay retain the latest transition, so late or reconnected Viewers learn the current local Segment without a cloud Segment row. Cue append/update keeps its original Segment ownership.

For Issue #41 local-only Meetings, a Viewer with a valid share starts the DataChannel even while cloud recording metadata is `created` or `waiting`. Snapshot, append/update, and replay Cues come only from the authorized Host. Local Segment IDs are checked for consistent Cue identity and session ownership without requiring cloud Segment rows; cloud reads remain limited to share authorization and connection metadata.

WebRTC recovery keeps the Redis signaling cursor monotonic for the participant
heartbeat lifetime, while individual offer/answer/ICE messages retain their
shorter TTL. This prevents a long quiet connection from resetting a new
`viewer-ready` message below the Device polling cursor.

Viewer reports `connected` only when PeerConnection is connected, ICE is
non-terminal, and the subtitle DataChannel is open. DataChannel ping/pong runs
every ten seconds; a 25-second unanswered ping triggers recovery, while absence
of Cue traffic alone never marks transport dead. Every replacement DataChannel
requests replay after the last source sequence and receives a full snapshot
when the source changed or retained replay history has a gap.

The initial snapshot returns the latest 100 Cues and an opaque cursor for
loading older pages. Each older page is merged by Cue ID without duplicates or
omissions. The Viewer uses `cueId` as the idempotency key and orders Cues by
Viewer 依 Segment 與 Cue 序號排序，對相同 `cueId` 獨立合併原文與翻譯版本；較舊版本不得覆蓋較新版本。

after ordered historical Cues. Source and translation versions merge independently.

Reconnect behavior: Viewer 保留現有 Cue，經授權的 `/join` 更新 signaling participant。短暫斷線先嘗試 ICE restart，再建立新的 PeerConnection／DataChannel；新通道依來源與序號要求 replay，缺口或來源變更時取得 Host snapshot。Cue 依 `cueId` 與來源／翻譯／潤飾版本合併，較舊版本不得覆蓋新版本。重試耗盡時保留字幕、捲動位置、字幕顯示偏好與全螢幕狀態，顯示手動重新整理動作。


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

Successful Meeting completion fixes `ended_at` and `purge_at` at 30 minutes later. Pause, reconnect and rollover do not extend the deadline. Ordinary Meeting／Viewer reads are denied after expiry; local OPFS／IndexedDB cleanup runs when the Host next opens or checks its content. Expiry is an authorization boundary, not a background deletion worker. Physical cloud metadata deletion uses the authorized Meeting deletion API.


## Security and Compatibility Constraints

Viewer 在 Recorder 尚未出現時維持單一 negotiation，週期性重送 `viewer-ready` 作為 discovery，不重建 PeerConnection 或消耗 transport recovery 次數。Recorder 在成功續租 signaling participant 後重設 discovery recovery budget；單一 Viewer peer 中斷不得停止其他 Viewer 或 Recorder 的 discovery poll。DataChannel 建立後仍以 Snapshot／Replay 補齊，再接續可靠有序的 Live Cue。

- Never expose `GEMINI_API_KEY`, user Gemini keys or ephemeral tokens to Viewers.
- Preserve `/api/live-token` authorization, rate limit and origin checks.
- Preserve share expiry, revocation and sanitized Viewer DTOs.
- Keep Host recording durability independent of Viewer delivery ACKs.


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
