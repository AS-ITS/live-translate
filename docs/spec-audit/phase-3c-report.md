# Live Translate OpenSpec Phase 3C：未移轉項目與覆蓋率審查

日期：2026-10-13（Asia/Taipei）。審查基線：Git HEAD `50b3d87`，加上 Phase 3B 未提交的四份主規格與 `phase-3b-report.md`。本報告只讀取程式、測試、盤點與 OpenSpec；不變更現行規格或 Viewer change。Issue／PR 對應沿用 `feature-matrix.md` 的既有盤點，**未重新查證 GitHub 當前狀態**。

## 1. 證據階層與四份主規格審查

證據不可跨層推論：**格式**是 OpenSpec parser 的 strict 結果；**實作**是本工作樹 source/migration 路徑；**自動化測試**是檢視測試斷言，並非本次執行通過；**Preview／Production** 必須有對應 build、部署、DB migration head、環境與結果記錄。本次後兩層皆無可追溯的當前通過記錄。`openspec validate --all --strict --no-interactive` 為 **5/5 通過**（四份主規格與 Viewer change），只證明格式，不證明產品行為。

下表每列代表一項 Requirement；括號中的數字是其 Scenario 數。`S`＝有源碼／SQL 實作證據；`T`＝有對應測試斷言但本次未執行；`T*`＝測試涵蓋部分命題或需環境旗標，不能當作完整端到端驗收。全部列的 Preview／Production 均為 `NOT_VERIFIED`。

| 主規格與 Requirement | S：實作證據 | T：自動化測試證據與審核判定 |
|---|---|---|
| `meeting-lifecycle`：一個 open Session／active Segment（2） | `supabase/migrations/20260924000000_issue37_meeting_lifecycle_v2.sql` 兩個 partial unique indexes | `tests/unit/meetingLifecycleMigration.test.js` 驗 SQL 文字；`tests/integration/meetingLifecycleV2.integration.test.js` 有本機 Supabase 併發案例，但需 `RUN_SUPABASE_LIFECYCLE_TESTS=true` 且本次未執行。`T*`，部署索引未驗。 |
| `meeting-lifecycle`：operation identity／version（2） | 同一 lifecycle SQL 的 replay-before-version 分支；`src/infrastructure/supabaseMeetingLifecycleService.js` 傳入 operation ID/version | migration unit 驗 RPC 存在；gated local-Supabase integration 測相同 start replay；`tests/unit/meetingCheckpointService.test.js` 驗本機 rollover 重送，**不是**同一 SQL RPC 的替代證明。`T*`。 |
| `meeting-lifecycle`：current recorder fence（1） | `supabase/migrations/20260924010000_issue37_validate_recorder_fence.sql`；Supabase adapter `validateWrite` | migration unit 驗 fence/expiry predicate，`tests/unit/meetingLifecycleHttpApi.test.js` 驗 HTTP stale-fence 接線；gated integration 有 stale-fence 案例。`T*`，未驗當前部署。 |
| `audio-buffering`：16 kHz／PCM16／100 ms 與 flush（2） | `src/lib/audio.js` 的 resample、PCM16、chunker；`src/lib/liveSession.js` 建立 chunker | `tests/unit/audio.test.js` 明確斷言 1,600 samples→3,200 bytes 與 partial flush。`T`。 |
| `audio-buffering`：Worklet fallback（1） | `src/lib/liveSession.js` 的 Worklet 建立與 ScriptProcessor fallback | `tests/unit/liveSessionFailureSignal.test.js` 模擬 Worklet 建立失敗及健康 callback。`T`；真機瀏覽器未驗。 |
| `audio-buffering`：pending queue／overflow（1） | `src/lib/liveSession.js` 的 64 chunks／480,000 bytes 預設、oldest-drop 與 diagnostics | `tests/unit/liveSessionProviderTransition.test.js` 以小容量驗 drop／diagnostic；`tests/unit/liveSessionFailureSignal.test.js` 驗 bounded newest window。`T`；超容量單一 chunk 不在規格 Scenario。 |
| `audio-buffering`：provider-ready／pre-commit cancel drain（2） | `src/lib/liveSession.js` 的 `drainPreRoll`、`cancelProviderTransition` | failure-signal test 驗 pre-ready queue；provider-transition test 驗取消未提交切換時舊 provider 收一次。`T`；不可外推至 committed replacement 零缺口。 |
| `local-persistence`：reserve→write→seal／conflict（2） | `src/lib/localMeetingRecorder.js`、`src/lib/localMeetingStorage.js` | `tests/unit/localMeetingRecorder.test.js`、`tests/unit/localMeetingStorage.test.js` 驗 seal、相同／不同內容 retry、OPFS overwrite。`T`。 |
| `local-persistence`：reconciliation／orphan（2） | 同上 `reconcileLocalMeetingChunks` 與 recorder restore | storage/recorder unit 測 matching file seal、corrupt、orphan 及 pre-seal crash window。`T`；任意 crash 零遺失未驗。 |
| `local-persistence`：同源 reload（1） | IndexedDB manifest、OPFS chunk store、`src/lib/localMeetingPersistence.js` | `tests/unit/localMeetingStorage.test.js` 內含 Headless Chromium reload、operation replay 與 OPFS refusal；測試檔存在但本次未執行。`T`。 |
| `local-persistence`：credential-shaped projection（1） | `src/lib/localMeetingStorage.js` 的投影與 key matcher | 同一 storage test 注入 `geminiApiKey` 等欄位並檢查 hydration；只涵蓋識別的 key family。`T`。 |
| `translation-glossary`：deterministic revision（2） | `src/lib/glossaryRevision.js` 的 canonical sort、SHA-256 | `tests/unit/glossaryRevision.test.js` 驗排序等價、欄位變更、server/browser hash。`T`。 |
| `translation-glossary`：Meeting override（1） | `src/lib/meetingGlossary.js` 的 merge | `tests/unit/meetingGlossary.test.js` 驗 same-source override／aliases；`tests/unit/glossaryContinueContract.test.js` 驗 token 設定。`T`。 |
| `translation-glossary`：Segment provider snapshot（2） | `server/tokenService.js` 的 authoritative Segment snapshot | `tests/unit/glossaryContinueContract.test.js` 驗同 Segment revision 不變／後續 Segment 使用新 snapshot；真實 Gemini 是否遵循 instruction 未驗。`T`。 |
| `translation-glossary`：stable Turn correction binding（1） | `src/lib/correctionGlossarySnapshot.js`、`src/lib/glossaryReplacement.js` | `tests/unit/correctionGlossarySnapshot.test.js` 驗 late final／new Turn revision；replacement test 驗 Cue-owned correction。`T`；無穩定 Turn identity 的例外已在 spec 限制說明。 |

審查結果：**15/15 Requirement 有可定位的實作與對應測試檔；23/23 Scenario 具 Given/When/Then 格式**。這是證據對照數，不是功能完成百分比，也不是測試當前通過率。Meeting 的 SQL 文字／本機 gated integration 與部署 DB 驗證仍有明顯落差。

Scenario 完整性另有四個**有條件通過**點，供下一次規格修訂使用：Meeting operation identity 的「同 ID、不同 payload」缺獨立 Scenario 與同 RPC 測試；recorder fence 的錯 Session/Segment 或缺欄位缺獨立 Scenario；AudioWorklet fallback 的「沒有雙 capture graph」沒有直接 Scenario 斷言；Glossary override 的 alias 結果仍以「依現行 merge contract」表述，需具體化可預期值。這些不使 strict 格式驗證失效，但不得稱作所有語意都已完全驗收。本階段不修改四份正式規格。

## 2. 未移轉項目分類

分類準則：`A IMPLEMENTED_EVIDENCE_GAP`＝可找到現行實作但規格／測試／目標環境證據不足；`B CONFIRMED_DEFECT`＝現行產品行為在明確環境重現並可追溯版本；`C FUTURE_REQUIREMENT`＝尚未採納或尚未實作的需求；`D DESIGN_UNDECIDED`＝需先選契約或邊界；`UNKNOWN`＝不能安全斷定。優先級是**補證／決策順序**，不代表已確認缺陷等級。以下 Issue／PR 為歷史關聯，不能單獨證明實作或缺陷。

| ID／Phase 3B 原始描述 | 模組／分類 | 程式碼位置；測試證據 | Issue／PR | 未移轉原因 → 後續建議；優先級 |
|---|---|---|---|---|
| U01 migration head、RLS 的 Preview／Production 狀態 | Meeting Lifecycle／A | lifecycle-v2 migrations、`src/infrastructure/supabaseMeetingLifecycleService.js`；`tests/unit/meetingLifecycleMigration.test.js`、`tests/integration/meetingLifecycleV2.integration.test.js`（gated） | #37／PR #39 | 無當前部署 ID、migration head、RLS 結果 → 建 verification manifest；P0 |
| U02 真實並發 lease／takeover | Meeting Lifecycle／A | lifecycle-v2 SQL RPC；gated local-Supabase integration 有併發 start/transition，未見對當前部署的 takeover trace | #37／PR #39 | 本機測試不等於部署併發驗收 → 對同 build 執行受控並發／fence 測試；P0 |
| U03 retention／physical deletion | Meeting Lifecycle／A | `src/application/meetingDeletionService.js`、`src/lib/meetingRetention.js`；`tests/unit/meetingDeletionService.test.js`、`tests/unit/meetingRetention.test.js` | #37／PR #39 | 既有手動刪除／visibility deadline 與舊自動清理文字需逐條調和 → 專題審核後移轉；P1 |
| U04 lifecycle-v1 相容細節 | Meeting Lifecycle／D | `src/application/meetingCheckpointService.js`、lifecycle-v2 SQL；`tests/unit/meetingLifecycleRegression.test.js` | #1、#37／PR #39 | 主規格只界定 v2；哪些 legacy 行為仍列正式契約未決 → 決定相容邊界；P1 |
| U05 SQL replay 的當前部署結果 | Meeting Lifecycle／A | lifecycle-v2 SQL replay 分支；gated `tests/integration/meetingLifecycleV2.integration.test.js` 有相同 operation replay | #37／PR #39 | 測試檔存在但沒有本次／部署通過證據 → 記錄本機 DB 與部署環境的獨立結果；P0 |
| U06 「不向舊 provider replay」候選過廣；committed replacement 未保證 | PCM Queue／A | `src/lib/liveSession.js` transition/drain；`tests/unit/liveSessionProviderTransition.test.js` 證明**未提交取消**會向舊 provider drain 一次 | #38、#41 | Phase 3B 已把 pre-commit 例外寫清；committed replacement 的完整矩陣未驗 → 分狀態補場景與 trace，不恢復絕對禁令；P0 |
| U07 Gap Recovery 無缺口保證 | PCM／Rollover／C | `src/lib/reconnectController.js`、`src/lib/providerRecoveryCoordinator.js` 有部分機制；unit/mock 非中斷音訊補轉錄驗收 | #41 | LAR-16～21 未完成，無零缺口證據 → 留 roadmap/change；P1 |
| U08 超過 byte capacity 的單一 PCM chunk | PCM Queue／UNKNOWN | `src/lib/liveSession.js` queue eviction；現有 overflow test 使用小於容量的 chunk，缺超大 chunk 斷言 | #38、#41 | 行為邊界不能由既有 Scenario 外推 → 加一個 isolated boundary test 再決定是契約或缺陷；P1 |
| U09 長時段、真實麥克風與 callback timing | PCM Queue／A | `src/lib/audio.js`、`src/lib/liveSession.js`；`tests/unit/audio.test.js`、failure-signal mocks | #5、#38、#41 | mock/unit 不能證明真機長錄音 → Preview 實裝置記錄 drop／gap／browser 版本；P0 |
| U10 OPFS quota／offline／private-mode | OPFS / IndexedDB／UNKNOWN | `src/lib/localMeetingStorage.js`、`src/lib/localMeetingPersistence.js`；Headless Chromium 正常路徑測試，缺上述環境矩陣 | #37、#38／PR #39 | 降級／錯誤 UI 契約與實際支援範圍不明 → 先決定支援矩陣並做受控失敗測試；P1 |
| U11 跨 tab 長時間壓力 | OPFS / IndexedDB／A | `src/lib/localMeetingRetention.js`；`tests/unit/localMeetingRetentionBrowser.test.js` 有跨 tab cleanup，無長壓結果 | #38／PR #39 | 現有短路徑證據不足 → 多 tab 長時段 lock／retention trace；P1 |
| U12 任意 crash 後零遺失 | OPFS / IndexedDB／C | recorder/storage 有 reconciliation；`tests/unit/localMeetingRecorder.test.js` 僅覆蓋界定的 crash window | #41／PR #39 | 絕對保證未實作／採納且無法由局部恢復測試推出 → 保留候選、改以可量測情境討論；P1 |
| U13 雲端 ACK／offline resend | Local Persistence／Supabase／A | `src/lib/cloudSaveCoordinator.js`、`src/lib/localMeetingPersistence.js`；`tests/unit/cloudSaveCoordinator.test.js`、`tests/cloud/stagingSmoke.spec.js` 存在 | #35、#37／PR #39 | ACK 與 durable commit／部署驗收未形成一對一證據 → 分 channel、idempotency、version/hash 建 manifest；P0 |
| U14 WebM 非初始 slice 解碼／60 秒 rotation 對產品的影響 | Recording / Export／UNKNOWN | `src/lib/microphoneRecording.js`；`spikes/webm-continuity/webmContinuitySpike.js`、`tests/e2e/webmContinuitySpike.spec.js`、`docs/verification/issue-41-phase-a.md` 有隔離失敗 | #41 | 只有 Chromium/macOS spike `REPRODUCED_IN_TEST`，非現行產品 Preview／Production 缺陷 → 先對現行 recorder/export 同 build 重現；P0 |
| U15 global／Meeting CRUD 與 CSV/JSON/XLSX import | Translation Glossary／A | `server/glossaryController.js`、`src/infrastructure/translationGlossary.js`、`src/infrastructure/supabaseGlossary.js`；`tests/unit/translationGlossary.test.js`、`tests/unit/glossaryHttpApi.test.js`、`tests/unit/supabaseGlossary.test.js` | #37／PR #30、#36 | Phase 3B 未逐 adapter 建正式 Scenario；檔案式實作與測試比原報告描述更完整，雲端一致性未驗 → 分檔案／Supabase 契約審核；P1 |
| U16 import invalid-row／revision conflict 細節 | Translation Glossary／A | `src/infrastructure/translationGlossary.js`；`tests/unit/translationGlossary.test.js` 已有 invalid XLSX、selected rows、stale revision 斷言；Supabase 對照仍待查 | #37／PR #30、#36 | **非完全缺測**；欠跨 adapter 契約對照 → 修正下一批證據表後再規格化；P1 |
| U17 真實 Gemini glossary instruction 遵循率 | Translation Glossary／A | `server/tokenService.js` 產生 instruction；`tests/unit/glossaryContinueContract.test.js` 只驗 config/mock | #37／PR #36 | provider 效果未實測，不能從 token config 推出 → 授權後小樣本實測並記錄模型／版本；P1 |
| U18 詞彙量上限與並發編輯政策 | Translation Glossary／D | `src/infrastructure/translationGlossary.js`、`src/infrastructure/supabaseGlossary.js`；現有 unit 不建立產品上限／衝突政策 SLA | #37／PR #30、#36 | 未採納量化限制與跨端衝突契約 → 決定支援上限及並發策略；P2 |
| U19 Viewer Subtitle Sync 全模組未移轉 | Viewer / WebRTC／A | `src/webrtc/subtitleTransport.js`、`src/webrtc/subtitleDataChannel.js`、`src/lib/meetingViewerRealtime.js`；`tests/e2e/meetingViewerLiveRegression.spec.js`、`tests/unit/meetingViewerRealtime.test.js` | #31、#38／PR #40 | snapshot/replay／ordering 有程式與測試，Production incident root cause 未明 → 先移轉可證的 delivery 契約；P0 |
| U20 Session Rollover / Reconnection 未移轉 | Rollover／A | `src/lib/reconnectController.js`、`src/lib/rolloverRecoveryCoordinator.js`、`src/lib/providerRecoveryCoordinator.js`；對應 unit tests | #3、#4、#41 | 控制路徑可見，但真實 GoAway/token 及同 build trace 未驗 → 先收窄程式契約；P0 |
| U20b #41 的 15 分鐘症狀／根因 | Rollover／UNKNOWN | 上述 controller 與 unit/mock；無對應 build 的 provider/Recorder 成對 trace | #41 | 只有 `SUSPECTED` 線索，無已確認根因 → 先重現並記錄事件時間線，不標 B；P0 |
| U21 Gemini Live 全模組未移轉 | Gemini Live／A | `src/lib/liveSession.js`、`server/tokenService.js`、`src/lib/geminiLiveCueEvent.js`；`tests/unit/liveSessionFailureSignal.test.js`、`tests/unit/liveSessionGlossaryBinding.test.js` | #2、#20／PR #24 | mock/unit 足以起草 direct/token/Cue 邊界，不足 provider SLA → 先規格化程式契約並標實測缺口；P0 |
| U22 Supabase / Cloud Sync 全模組未移轉 | Supabase／A | `src/lib/cloudSaveCoordinator.js`、`src/infrastructure/supabaseMeetingLifecycleService.js`；`tests/unit/cloudSaveCoordinator.test.js`、`tests/cloud/stagingSmoke.spec.js` | #35、#37／PR #39 | 部署 migration/RLS/ACK 證據缺 → 分 repository 與環境驗收；P0 |
| U23 Recording / Export 全模組未移轉 | Recording / Export／A | `src/lib/microphoneRecording.js`、`src/lib/meetingTranscriptExport.js`、`src/application/exportArtifactService.js`；recorder/export unit tests | #6、#16、#38、#41／PR #17 | 現行匯出與 spike 分開；先收錄 TXT/SRT/VTT／artifact state，WebM 候選另查；P0 |
| U24 Authentication / Administration 全模組未移轉 | Auth/Admin／A | `server/accessControl.js`、`server/adminService.js`、`src/lib/supabaseAuth.js`；`tests/integration/accountPermissions.integration.test.js`、`tests/unit/adminService.test.js` | #33／PR #34 | role/status 程式可見，OAuth redirect/RLS 部署驗收缺 → 先列 server guard，後列環境條件；P1 |
| U25 UI / RWD / Fullscreen 全模組未移轉 | UI／A | `src/pages/viewer/MeetingViewerPage.jsx`、`src/lib/viewerFontSizePreference.js`；`tests/e2e/meetingViewerFullscreen.spec.js`、`tests/e2e/headerResponsive.spec.js` | #29；Viewer 字級 change | mock/browser 行為與真實 mobile Safari/native fullscreen 不同層；字級 change 仍 0/7 → 待 change 驗收，先審查其他 UI 契約；P1 |
| U26 Transcribe Live + Flash translation/refinement | Gemini Live／C | `src/lib/liveTranscriptionSession.js` 不能證明此替代 pipeline 已成為現行 Meeting path；現有 Live Translate tests 不等於此 pipeline 驗收 | #20、#41 | 明列未來方案 → 保留 roadmap/change，不進主規格；P2 |
| U27 #41 LAR-16～21 中斷音訊補轉錄 | Rollover／Recording／C | recovery controller 與 OPFS spool 只提供部分前置；`docs/verification/issue-41-phase-a.md` 尚列 pending | #41 | 未完成需求 → 另行 change/驗收，不能寫成現行恢復能力；P1 |
| U28 TURN／relay 選型與 10/50/100 viewers | Viewer / WebRTC／D | `src/webrtc/subtitleTransport.js`；現有 Viewer E2E 不構成多網路／多 viewer 選型證據 | #31、#38／PR #40 | 架構與成本／部署決策未定 → 先完成壓測及網路矩陣再決策；P2 |

**B `CONFIRMED_DEFECT`：目前為 0 項。** U14 是隔離測試失敗，不是已確認的現行產品缺陷；U20 的 15 分鐘根因未知。若後續在標定 build 的 Preview／Production 或現行產品測試環境重現，才新增 B，並保留原始失敗紀錄與環境標籤。

## 3. 11 模組規格覆蓋率矩陣

此矩陣描述**契約覆蓋與證據狀態**，不以檔案數或 Requirement 數計算功能完成百分比。「已知缺陷」只指已確認的現行產品缺陷；隔離 spike 及待查症狀另列未驗。

| 模組 | 已建立現行規格 | 已實作未規格化 | 有條件通過範圍 | 已知缺陷 | 未來需求／設計候選 | 未驗證行為 |
|---|---|---|---|---|---|---|
| Meeting Lifecycle | `meeting-lifecycle`：v2 唯一性、operation/version、fence | deletion/retention、legacy v1、takeover | v2 program contract；部署未驗 | 無已確認 | legacy 契約界線 D | migration/RLS、併發／SQL replay |
| Gemini Live Transcription / Translation | 無 | direct Live/token/Cue 路徑 | 僅 source/mock 層可移轉 | 無已確認 | Transcribe Live + Flash C | 真實 provider、長連線、token expiry |
| PCM Queue / Audio Buffering | `audio-buffering`：PCM、fallback、queue、drain | committed transition、長時段 | 常規 chunk 的 unit/mock contract | 無已確認 | 零缺口 Gap Recovery C | 超大 chunk、真機／部署 |
| Session Rollover / Reconnection | 無 | reconnect／rollover controller | unit/mock state contract 可審 | 無；15 分鐘根因 UNKNOWN | LAR-16～21 C | 真實 GoAway、同 build trace、部署 |
| Viewer / WebRTC / Subtitle Sync | 無 | snapshot/replay/DataChannel/ordering | source/E2E-mock protocol 可審 | 無；Production incident 根因 UNKNOWN | TURN/relay 與 10/50/100 viewers D | 多網路、配對 trace、部署 |
| OPFS / IndexedDB | `local-persistence`：journal/reconcile/reload/projection | quota/offline/cross-tab、cloud ACK 跨模組 | Headless Chromium 正常路徑 | 無；WebM spike 非已確認產品缺陷 | 任意 crash 零遺失 C | Safari/private/quota、部署 |
| Supabase / Cloud Sync | 無 | repository/RPC/channel coordinator | repository/mock contract 可審 | 無已確認 | 雲端契約邊界待收斂 | migration head、RLS、ACK、staging |
| Glossary | `translation-glossary`：revision/override/snapshot/Turn | CRUD/import adapters | deterministic／token-config contract | 無已確認 | 上限／並發政策 D | 真實 Gemini instruction、雲端 import parity |
| Recording / Export | 無 | MediaRecorder、TXT/SRT/VTT、artifact states | 現行 export source/unit contract | 無；WebM 隔離失敗 `REPRODUCED_IN_TEST` | Gap Recovery C；container 決策 D | 現行產品 WebM、部署 |
| Authentication / Administration | 無 | role/status/admin guard | server guard/mock contract 可審 | 無已確認 | 部署政策待收斂 | OAuth redirect、RLS、domain env |
| UI / RWD / Fullscreen | 無；Viewer 字級仍在 change | CSS/controls/fullscreen | mock-browser presentation contract | 無已確認 | 字級 change 7 tasks 待驗 | iOS Safari、native fullscreen、touch/safe-area |

## 4. 跨模組證據缺口與 Phase 3D 順序

共同缺口：沒有把目前 HEAD、部署 ID/URL、DB migration head、RLS、browser/device、測試命令及結果綁成一份 Preview／Production manifest；因此四份主規格與其餘模組都只能主張 program-level 現行契約。另一個盤點錯誤是 `feature-matrix.md` 的 Viewer 測試 `viewerPauseContinuity.spec.js` 目前不存在，實際檔案為 `tests/e2e/viewerPauseContinue.spec.js`；本階段只在此報告標記，未改既有盤點。

建議依相依與風險小批移轉，不把待查症狀寫成 SHALL：

1. **3D-1 Gemini Live → Viewer Subtitle Sync**。先鎖定 token/setup/Cue 的現行程式契約，再鎖定授權 snapshot/replay/DataChannel/ordering。兩者 source/test 證據可用、影響核心路徑；真實 provider 與 Production incident 根因分別保持未驗。
2. **3D-2 Session Rollover / Reconnection → Recording / Export**。依賴第一批的 provider/Cue 邊界；先取同 build Recorder/Viewer trace 與長時段／現行 recorder WebM 重現，再只移轉確認的 state/fence 與 TXT/SRT/VTT／artifact 契約。#41 LAR-16～21、零缺口、隔離 WebM 失敗不進主規格。
3. **3D-3 Supabase / Cloud Sync → Authentication / Administration**。依賴 lifecycle/local journal 的 ownership 與 ACK；先補 migration/RLS/role 驗證 manifest，再分 repository 契約與部署政策，不把本機 SQL 或 mock HTTP 當 Production。
4. **3D-4 UI / RWD / Fullscreen**。先完成 Viewer 字級 change 的七項驗收，再審可獨立移轉的 presentation 契約；真機 Safari/native fullscreen 另有驗收門檻。

## 5. 需要使用者決策

1. lifecycle-v1／舊文件相容性要納入正式主規格，還是只保留 legacy appendix？此決定影響 Meeting 與 Supabase 的下一批契約邊界。
2. 對 committed provider replacement、Gap Recovery、任意 crash 音訊保存，要採何種**可量測**目標？未定前不能使用「無缺口／零遺失」規範語句。
3. OPFS unsupported/private/quota、Glossary import 跨 adapter parity、詞彙量／並發、Viewer TURN/relay 的支援政策與優先順序，需選定後才能形成相應需求。
4. 是否安排標定 build 的 Preview／Production 驗證包？若是，需提供允許的部署環境與測試權限；本報告沒有執行任何外部驗證。

## 6. 執行與停止點

本階段只新增 `docs/spec-audit/phase-3c-report.md`。未執行產品測試或真實 Gemini API；未修改正式 Specs、Viewer tasks、既有 Changes、產品程式碼、API、資料庫、測試或部署設定；未 archive、commit、push、merge 或部署。
