# Live Translate OpenSpec 導入前系統盤點

## 盤點基線

- 盤點日期：2026-10-13（Asia/Taipei）
- Git HEAD：`37b2d10` (`docs(issue-41): record sampling correction`)
- 證據優先順序：目前工作樹程式碼 > 目前測試 > 架構／功能文件 > Git 歷史 > Issue／PR 歷史敘述。
- 本次是靜態盤點，未重跑測試、未呼叫 Gemini 真實 API、未部署。
- 工作樹在盤點前已有使用者變更：`CHANGELOG.md`、`docs/features/audio-device-selection.md`、`tests/e2e/liveTranslate.spec.js`；本盤點不修改它們。
- `.agents/` 與 `openspec/` 目前為 Git 未追蹤路徑，因此 OpenSpec 是「已在工作樹初始化」，不能視為「已納入版本控制」。

## OpenSpec 現況

| 項目 | 結果 | 證據 |
|---|---|---|
| 專案 root | 已初始化 | `openspec list --json` 回傳 `/Users/pochun/projects/live-translate` |
| 主要 specs | 0 | `openspec list --specs --json` 回傳空清單；`openspec/specs/.gitkeep` |
| 進行中 changes | 1 | `formalize-viewer-subtitle-font-size` |
| change 規劃 | 完成 | proposal、design、delta spec、tasks 皆存在 |
| change 實作任務 | 0/7 勾選 | `openspec/changes/formalize-viewer-subtitle-font-size/tasks.md` |
| 已歸檔 changes | 0 | `openspec/changes/archive/.gitkeep` |

## 執行中系統輪廓

```text
Recorder browser
  microphone -> AudioWorklet/ScriptProcessor -> PCM16 bounded queue
      |                                      -> Gemini Live (direct browser connection)
      +-> MediaRecorder chunks -> OPFS
      +-> Cue/checkpoint/operation/audio metadata -> IndexedDB queues
      +-> explicit HTTP writes -> Node API -> Supabase

Supabase / Node API
  auth + meeting settings + lifecycle RPC + cue/checkpoint + glossary
  +-> viewer authorization/signaling
  +-> cloud export/audio artifact metadata

Viewer browser
  authorized snapshot/replay -> WebRTC DataChannel preferred
                             -> limited fallback/recovery transport
  -> ordered subtitle state -> responsive/fullscreen bilingual display
```

## 模組級總覽

| 模組 | 目前基線判定 | 核心程式證據 | 核心測試證據 |
|---|---|---|---|
| Meeting Lifecycle | `CONFIRMED_IMPLEMENTED`（程式／自動測試）；部署未驗 | `useLiveRecordingController.js`, `meetingCheckpointService.js`, `supabaseMeetingLifecycleService.js`, `20260924000000_issue37_meeting_lifecycle_v2.sql` | `meetingLifecycleHttpApi.test.js`, `meetingCheckpointService.test.js`, `meetingLifecycleMigration.test.js` |
| Gemini Live Transcription / Translation | `IMPLEMENTED_UNVERIFIED` | `liveSession.js`, `liveTranscriptionSession.js`, `tokenService.js`, `googleGenAIClient.js` | `liveSessionFailureSignal.test.js`, `liveSession.test.js`, `liveTranslate.spec.js` |
| PCM Queue / Audio Buffering | `CONFIRMED_IMPLEMENTED`（程式／自動測試）；真機未驗 | `audioCapture.worklet.js`, `audio.js`, `liveSession.js` | `audio.test.js`, `liveSessionProviderTransition.test.js`, `liveSessionFailureSignal.test.js` |
| Session Rollover / Reconnection | `IMPLEMENTED_UNVERIFIED`；#41 的 15 分鐘症狀 `SUSPECTED`，實際 provider rollover／Preview／Production `NOT_VERIFIED` | `reconnectController.js`, `rolloverRecoveryCoordinator.js`, `providerRecoveryCoordinator.js`, `segmentSwitchOrchestrator.js` | `reconnectController.test.js`, `rolloverRecoveryCoordinator.test.js`, `providerRecoveryCoordinator.test.js` |
| Viewer / WebRTC / Subtitle Sync | `IMPLEMENTED_UNVERIFIED` | `MeetingViewerPage.jsx`, `subtitleTransport.js`, `subtitleDataChannel.js`, `meetingViewerRealtime.js` | `meetingViewerLiveRegression.spec.js`, `publicMeetingViewer.spec.js`, `meetingViewerFullscreen.spec.js` |
| OPFS / IndexedDB | `CONFIRMED_IMPLEMENTED`（程式／自動測試）；壓力未驗 | `localMeetingStorage.js`, `localMeetingRecorder.js`, `localMeetingPersistence.js`, `localMeetingRetention.js` | `localMeetingStorage.test.js`, `localMeetingRecorder.test.js`, `localMeetingRetentionBrowser.test.js` |
| Supabase / Cloud Sync | `IMPLEMENTED_UNVERIFIED` | `supabase*` infrastructure modules, `cloudSaveCoordinator.js`, migrations | `cloudSaveCoordinator.test.js`, `meetingLifecycleMigration.test.js`, `tests/cloud/*` |
| Glossary | `CONFIRMED_IMPLEMENTED`（程式／自動測試） | `features/glossary`, `supabaseGlossary.js`, `meetingGlossary.js`, `glossaryController.js` | `glossaryHttpApi.test.js`, `glossaryRevision.test.js`, `glossaryContinueContract.test.js`, glossary E2E |
| Recording / Export | 現行路徑 `CONFIRMED_IMPLEMENTED`；隔離 WebM slice／rotation 候選 `REPRODUCED_IN_TEST`；Preview／Production 影響 `NOT_VERIFIED` | `microphoneRecording.js`, `localMeetingAudioExport.js`, `meetingTranscriptExport.js`, `CloudMeetingExportPanel.jsx` | `microphoneRecording.test.js`, `localMeetingAudioExport.test.js`, `exportArtifactService.test.js` |
| Authentication / Administration | `IMPLEMENTED_UNVERIFIED` | `AuthGate.jsx`, `supabaseAuth.js`, `adminService.js`, `account-permissions.md`, auth/account migrations | `accountPermissions.integration.test.js`, `adminService.test.js`, account E2E |
| UI / RWD / Fullscreen | `CONFIRMED_IMPLEMENTED`（模擬瀏覽器）；真機未驗 | `MeetingViewerPage.jsx`, `viewerFontSizePreference.js`, responsive CSS | `meetingViewerFullscreen.spec.js`, `headerResponsive.spec.js`, `accountRoleManagement.spec.js` |

## 驗證環境狀態

| 環境 | 盤點結論 | 不可延伸的解讀 |
|---|---|---|
| Unit / integration / mocked E2E | 大多數模組有對應測試檔；本次未重跑 | 測試檔存在不等於目前 commit 已在本機通過 |
| Chromium 隔離實驗 | Issue #41 Phase A 有可用結果；WebM 非初始 slice 解碼失敗，60 秒 rotation 候選未通過 20 ms gate | 不是真實 Gemini rollover，不能代表 Preview／Production |
| Preview | Origin/CORS、真機、reload/crash、quota/offline 驗收仍列為 pending | `localDevicePoc.spec.js` 的 synthetic preview origin 不等於已部署 Preview |
| Production | Viewer 事故根因 `NOT CONFIRMED` | 需同一 incident/build 的 Recorder + Viewer 成對 trace |
| 真實裝置 | macOS Chrome、Windows Chrome、Safari/WebKit `NOT VERIFIED` | 不可宣稱長時間錄音或 fullscreen 已真機驗收 |
| 真實 Gemini API | `NOT VERIFIED` | 專案規則要求 `ENABLE_REAL_GEMINI_TEST=true` 且需明確授權 |

## 狀態定義

- `CONFIRMED_IMPLEMENTED`：目前程式路徑存在，且有對應的自動測試或已記錄驗證證據。不自動代表 Preview／Production／真機通過。
- `IMPLEMENTED_UNVERIFIED`：程式已接線，但缺乏本次目標環境的驗收證據。
- `KNOWN_DEFECT`：現行產品行為的失敗已在明確環境重現；須同時註明 `CONFIRMED_PRODUCTION`、`CONFIRMED_PREVIEW` 或 `REPRODUCED_IN_TEST`，且隔離實驗不可直接外推為部署缺陷。只有 Issue 或未確定根因時標 `SUSPECTED`／`NOT_VERIFIED`。
- `PLANNED`：只出現在路線圖、Issue、規劃文件或未完成 OpenSpec change，不畫為現行功能。
- `UNKNOWN`：證據不足或互相衝突，必須補證後才能判定。
