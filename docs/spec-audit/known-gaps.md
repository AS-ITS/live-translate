# Live Translate 已知缺口與證據衝突

## P0 失敗證據與待驗證風險

證據標籤定義：`CONFIRMED_PRODUCTION` 與 `CONFIRMED_PREVIEW` 需要對應環境、部署版本及重現紀錄；`REPRODUCED_IN_TEST` 限定測試設定；`SUSPECTED` 是待排查線索；`NOT_VERIFIED` 表示尚無足夠驗收證據。目前 GAP-001/002 無 Preview 或 Production 重現紀錄。`KNOWN_DEFECT` 只描述已重現的**隔離實驗候選**，不描述目前產品錄音或 provider rollover 已失效。

### GAP-001：分割 WebM 不能假設每段都可獨立解碼

- 狀態：`REPRODUCED_IN_TEST`（隔離候選）；Preview `NOT_VERIFIED`；Production `NOT_VERIFIED`。
- 證據：`docs/verification/issue-41-phase-a.md` 記錄 Playwright Headless Chromium 149.0.7827.55/macOS 下，抽樣的非初始 1 秒 slice 出現 `EncodingError`，完整 container 通過；測試 harness 見 `spikes/webm-continuity/`，commit `fcad972`。
- 影響：未來中斷缺口補轉錄、chunk-level recovery 若設計成獨立解碼任意 WebM slice，將面臨已觀測的相容性問題；現行本機匯出是否受影響仍 `NOT_VERIFIED`。
- 追溯：[#41](https://github.com/pochun1021/live-translate/issues/41)，commit `fcad972`、`9cc3d9f`。
- 缺少驗證：macOS Chrome、Windows Chrome、Safari/WebKit，不同 MediaRecorder mime type，真實長時間 container。

### GAP-002：60 秒 rotation 候選未通過事先定義的 20 ms gate

- 狀態：`REPRODUCED_IN_TEST`（60 秒 stop/start 候選未通過 gate）；Preview `NOT_VERIFIED`；Production `NOT_VERIFIED`。
- 證據：同一 Headless Chromium/macOS harness 中，rotation 相對 continuous 的 decoded-vs-capture drift penalty 為 `−25.33 ms`，絕對值超過預先設定的 20 ms gate；快速 4 秒試驗約 `70.67 ms` penalty，亦未通過。數字不是已證實的可聽缺口或 Production recorder 缺陷。
- 影響：不能將該候選直接推進 Gap Recovery 或宣稱無縫錄音；現行 Recorder 並未採用這項 60 秒 rotation 候選。
- 追溯：[#41](https://github.com/pochun1021/live-translate/issues/41)。
- 缺少測試：長時間、真實麥克風、多瀏覽器、pause/resume/rollover 組合的精確 sample accounting。

### GAP-003：Production Viewer 事故根因未確認

- 狀態：使用者回報 `SUSPECTED`；失敗事件、根因及目前 Production build 之重現狀態均 `NOT_VERIFIED`。取得同 build 成對 trace 並重現後，才可標為 `CONFIRMED_PRODUCTION`。
- 證據：`docs/verification/issue-41-phase-a.md` 明確標示 `NOT CONFIRMED`。
- 影響：不能將現有 WebRTC/recovery 測試解讀成 Production 事故已修復。
- 需求證據：同一 incident/build 的 Recorder + Viewer 成對 trace，含 transport generation、snapshot/replay cursor、Cue revision 與時間對齊。
- 追溯：[#41](https://github.com/pochun1021/live-translate/issues/41)，commits `a28efa2`、`9d7187e`、`11b513c`、`c2c0de4`。

### GAP-004：關鍵路徑缺 Preview／Production／真機驗收記錄

- 狀態：程式路徑 `IMPLEMENTED_UNVERIFIED`；Preview/Production/真機 `NOT_VERIFIED`。
- 範圍：Gemini Live、lifecycle RPC，OPFS quota/offline/reload，Supabase migration/RLS，OAuth redirect/domain activation，Viewer WebRTC，fullscreen。
- 證據：`docs/architecture/architecture-overview.md` 與 Phase A 均將 Mac/Windows microphone、reload/crash、quota/offline、Preview/Production Origin/CORS 列為 pending；Safari/WebKit 也未驗。
- 風險：當前只能建立程式基線，不能建立部署 SLA 或瀏覽器相容性 spec。

## 規格／文件／程式衝突

| ID | 衝突 | 證據 A | 證據 B | 本次處理 |
|---|---|---|---|---|
| CONFLICT-001 | Viewer 字級 OpenSpec 任務顯示 0/7，但實作已在工作樹 | `openspec/.../tasks.md` 全未勾選 | `viewerFontSizePreference.js`, `MeetingViewerPage.jsx`, CSS, unit/E2E，commit `6bde950` | 不假設 change 已完成；先做 requirement-by-requirement 驗證再回填 tasks |
| CONFLICT-002 | 產品 spec 的 Future Enhancements 仍列帳號、history、export，但程式已實作對應功能 | `docs/spec.md` Future Enhancements | Auth/admin/history/export source、migrations 與 tests | 視為文件過時，不據此降級程式判定；待 OpenSpec 建立後同步舊 spec |
| CONFLICT-003 | 專案說明仍以 Phase 1 完成為主，目前程式已含 Phase 2/3 型的 auth、Supabase、admin、cloud export | `AGENTS.md` Project Context/Phase Rules | `src/components/AuthGate.jsx`, admin/cloud modules, migrations | 不自行重新宣告專案 phase；OpenSpec migration 必須以 capability 為單位 |
| CONFLICT-004 | 早期 file-backed/stateless 描述與現行 Supabase lifecycle 共存 | `docs/spec.md`, `docs/architecture.md` 的 MVP/legacy 段落 | Supabase repositories/RPC/migrations，architecture overview v2 | 在未來 spec 明確標示 legacy compatibility，不將早期敘述畫為當前 source of truth |
| CONFLICT-005 | Issue #38 已 closed，但其部分長錄音驗收仍在 #41/驗證文件未完 | GitHub #38 closed / PR #40 merged | #41 open；Phase A failure/pending matrix | Closed 只表示工作項目關閉，不作為功能無缺陷證明 |
| CONFLICT-006 | 自動清理與手動刪除的歷史說法可能誤導 | 舊 lifecycle/cleanup 敘述與 legacy RPC 名稱 | Architecture Overview v2：`purge_at` 是 visibility deadline，無 Cron/GET-triggered 實體刪除，由 super_admin 手動刪除 | 未來 spec 只採 v2 當前行為，legacy RPC 記為 compatibility no-op |

## 新發現的可追蹤缺口

| ID | 發現 | 狀態 | 證據／缺口 | 建議 |
|---|---|---|---|---|
| NEW-001 | OpenSpec 目錄未納入 Git | `UNKNOWN` | `git status --short` 顯示 `?? openspec/` | 審核盤點後再決定是否連同 config/change 納版控 |
| NEW-002 | 實作基線不是 clean HEAD | `UNKNOWN` | 盤點前已有 3 個 modified files | 正式 migration 前定義 baseline commit，否則 spec 難以重現 |
| NEW-003 | Cloud staging 測試檔存在，但沒有與當前 HEAD 綁定的通過報告 | `IMPLEMENTED_UNVERIFIED` | `tests/cloud/stagingSmoke.spec.js` 等檔案；盤點未找到當前 build/deployment/result 三者關聯 | 建立 verification manifest，記錄 commit、deployment URL/ID、migration head、browser、time |
| NEW-004 | 模擬 Playwright 有 fullscreen/RWD 覆蓋，但無真實 mobile Safari 觸控/安全區驗收 | `IMPLEMENTED_UNVERIFIED` | `meetingViewerFullscreen.spec.js` 有 CSS fallback/native mock；Phase A 標示 Safari/WebKit 未驗 | 開真機 acceptance item，不先改產品 CSS |

## 共通缺測

1. Preview 與 Production 的 Origin/CORS/auth redirect/RLS 實際設定。
2. 真實 Gemini Live 的 token expiration、GoAway、rollover、glossary revision 與音訊連續性。
3. Mac Chrome、Windows Chrome、Safari/WebKit 的 2+ 小時麥克風、OPFS、reload/crash、quota/offline 矩陣。
4. Production Viewer 在多網路、10/50/100 peers、direct/TURN/fallback 分類的端對端證據。
5. Supabase migration head、RLS、Storage late-write guard、manual deletion 與部署 build 的一致性檢查。
