# Live Translate Master Feature Registry

基線：2026-10-13，Git `6b4662e`。本文件是後續 OpenSpec 開發的唯一功能索引，整合 [功能矩陣](../spec-audit/feature-matrix.md)、[Phase 3B](../spec-audit/phase-3b-report.md)、[Phase 3C](../spec-audit/phase-3c-report.md)、四份現行 OpenSpec 主規格及仍開啟的 Viewer change；不是新一輪程式、Issue 或部署盤點。Issue／PR 對應沿用既有盤點，未重新查證 GitHub。ID 綁定使用者可辨識的 Capability，不綁定檔案、實作技術或完成狀態；將來改名仍保留 ID。每項功能只設一個 Primary Capability；可引用多份 Spec，但其他 Capability 的交叉引用不重複定義 Requirement 或擴大現行契約。

層級為 **L1 System：Live Translate → L2 Domain → L3 Capability（下列穩定 ID）→ L4 Requirement → L5 Scenario**。只有已採納的四份主規格具有現行 L4/L5 契約，共 **15 Requirement、23 Scenario**；本 Registry 不改寫它們。尚未形式化的 Capability 不以本表敘述代替 SHALL 或 Given/When/Then。草案 change 不是現行主規格。

## 六大 Domain 與 Capability 功能樹

- **REC｜錄製與會議管理**：`REC-001` 會議與錄製生命週期；`REC-002` 原音錄製。
- **AI｜語音辨識與翻譯**：`AI-001` 即時辨識／翻譯；`AI-002` 翻譯詞彙表；`AI-003` 來源轉錄後非同步翻譯（未來候選）。
- **VIEW｜Viewer 與字幕**：`VIEW-001` 即時字幕傳送與同步；`VIEW-002` Viewer 閱讀呈現；`VIEW-003` 多網路／多 Viewer 傳輸選型（待決設計）。
- **DATA｜資料保存與匯出**：`DATA-001` 本機錄製資料保存；`DATA-002` 雲端同步；`DATA-003` 逐字稿與錄音匯出。
- **AUTH｜使用者與權限**：`AUTH-001` 登入、授權與管理。
- **SYS｜系統可靠性與共用介面**：`SYS-001` 音訊 PCM 緩衝；`SYS-002` Provider 續接與 rollover 協調；`SYS-003` 中斷音訊補救（未來候選）；`SYS-004` 跨頁面響應式介面。

## Master Feature Registry

狀態分三軸管理：**Implementation（實作）** `CONFIRMED_IMPLEMENTED`＝既有盤點有明確程式路徑，不代表環境驗收；`IMPLEMENTED_UNVERIFIED`＝可見部分實作但整體契約待核；`PLANNED`＝未作為現行能力採納；`DESIGN_UNDECIDED`＝契約／選型未定。**Specification（規格）** `CURRENT`＝主規格；`CHANGE_OPEN`＝未完成 change；`UNFORMALIZED`＝未有主規格；`ROADMAP_ONLY`／`DECISION_PENDING` 均不可充作現行契約。**Verification（驗證）** `S+T(ref)`＝既有審查定位了 source 和測試斷言，**本次未重跑**；`S(ref)`＝只可引用程式／設計線索。所有列的 Preview、Production 均為 `NOT_VERIFIED`，格式驗證不會升級這兩者。Phase 3C 的 `U01–U28` 及 `U20b` 共 29 項在各列「未移轉 ID」中各有一個主歸屬；跨能力關聯另以文字說明，不重複計數。

### REC｜錄製與會議管理

**REC-001｜會議與錄製生命週期**：主要擁有 Meeting、Session、Segment 的持久化狀態轉移、命令版本與 recorder 寫入權限；rollover 的 lifecycle 邊界屬此處，provider 連線恢復與音訊重送不屬此處。技術模組：Meeting Lifecycle。

- OpenSpec：[`meeting-lifecycle`](../../openspec/specs/meeting-lifecycle/spec.md)；Change：無。Issue／PR：#1、#37／PR #39。未移轉 ID：**U01–U05**。
- 實作 `CONFIRMED_IMPLEMENTED`；規格 `CURRENT`（僅 lifecycle-v2 的 3 Requirement、5 Scenario）；驗證 `S+T(ref)`，Preview／Production `NOT_VERIFIED`。
- 未來／待決：retention、physical deletion、lifecycle-v1 相容邊界與真實 takeover 不在這 3 項契約內。證據：lifecycle-v2 migration、`src/infrastructure/supabaseMeetingLifecycleService.js`、`tests/unit/meetingLifecycleMigration.test.js`；[Phase 3C §2](../spec-audit/phase-3c-report.md)。

**REC-002｜原音錄製**：從錄製裝置擷取原音並形成可保存音訊；匯出交由 `DATA-003`。技術模組：Recording / Export 的錄音側。

- OpenSpec：無；Change：無。Issue／PR：#6、#38、#41。未移轉 ID：**U14**。
- 實作 `CONFIRMED_IMPLEMENTED`（錄音路徑）；規格 `UNFORMALIZED`；驗證 `S+T(ref)`，Preview／Production `NOT_VERIFIED`。
- 未來／待決：WebM 非初始 slice 的 `EncodingError` 與 60 秒 rotation 差異只在 Chromium/macOS 隔離實驗 `REPRODUCED_IN_TEST`，**不是已確認產品缺陷**。證據：`src/lib/microphoneRecording.js`、`tests/e2e/webmContinuitySpike.spec.js`、[Phase 3C U14](../spec-audit/phase-3c-report.md)。

### AI｜語音辨識與翻譯

**AI-001｜即時辨識與翻譯**：目前 Meeting 以 Gemini Live direct translation、token 與 Cue 事件提供即時內容。技術模組：Gemini Live Transcription / Translation。

- OpenSpec：無；Change：無。Issue／PR：#2、#20／PR #24。未移轉 ID：**U21**。
- 實作 `IMPLEMENTED_UNVERIFIED`；規格 `UNFORMALIZED`；驗證 `S+T(ref)`，真實 provider／Preview／Production `NOT_VERIFIED`。
- 未來／待決：真實 provider SLA 不從 mock 推定。證據：`src/lib/liveSession.js`、`server/tokenService.js`、`tests/unit/liveSessionFailureSignal.test.js`、[Phase 3C U21](../spec-audit/phase-3c-report.md)。

**AI-002｜翻譯詞彙表**：提供詞彙 revision、Meeting override、Segment snapshot 與 Turn correction 綁定。技術模組：Glossary。

- OpenSpec：[`translation-glossary`](../../openspec/specs/translation-glossary/spec.md)；Change：無。Issue／PR：#37／PR #30、#36。未移轉 ID：**U15–U18**。
- 實作 `CONFIRMED_IMPLEMENTED`；規格 `CURRENT`（4 Requirement、6 Scenario，**不含**完整 CRUD/import 契約）；驗證 `S+T(ref)`，真實 Gemini instruction／Preview／Production `NOT_VERIFIED`。
- 未來／待決：跨 adapter 匯入、詞彙上限與並發政策；U16 不是「完全缺測」。證據：`src/lib/glossaryRevision.js`、`src/lib/meetingGlossary.js`、`tests/unit/glossaryRevision.test.js`、[Phase 3C U15–U18](../spec-audit/phase-3c-report.md)。

**AI-003｜來源轉錄後非同步翻譯**：Transcribe Live 加 Flash translation/refinement 的替代管線候選；不等於目前 Meeting direct Live 路徑。

- OpenSpec：無；Change：無。Issue：#20、#41。未移轉 ID：**U26**。
- 實作 `PLANNED`（零件存在不證明整條管線已採用）；規格 `ROADMAP_ONLY`；驗證 `S(ref)`，Preview／Production `NOT_VERIFIED`。
- 未來需求：先採納端到端契約與驗收範圍，才可提出 change；不得加入現行主規格。證據：[Phase 3C U26](../spec-audit/phase-3c-report.md)、`src/lib/liveTranscriptionSession.js`。

### VIEW｜Viewer 與字幕

**VIEW-001｜即時字幕傳送與同步**：Viewer 接收授權快照、增量 Cue、replay 與順序控制。技術模組：Viewer / WebRTC / Subtitle Sync。

- OpenSpec：無；Change：無。Issue／PR：#31、#38／PR #40。未移轉 ID：**U19**。
- 實作 `IMPLEMENTED_UNVERIFIED`；規格 `UNFORMALIZED`；驗證 `S+T(ref)`，配對 trace／Preview／Production `NOT_VERIFIED`。
- 未來／待決：Production 事件根因未確定，不記為 `CONFIRMED_DEFECT`。證據：`src/webrtc/subtitleTransport.js`、`src/lib/meetingViewerRealtime.js`、`tests/e2e/meetingViewerLiveRegression.spec.js`、[Phase 3C U19](../spec-audit/phase-3c-report.md)。

**VIEW-002｜Viewer 閱讀呈現**：字幕字級、雙語可見性、歷史閱讀位置及 Viewer fullscreen 控制；不擁有傳輸協定。技術模組：Viewer / WebRTC / Subtitle Sync 的呈現側、UI / RWD / Fullscreen 的 Viewer 側。

- OpenSpec：無現行主規格；Change：[`formalize-viewer-subtitle-font-size`](../../openspec/changes/formalize-viewer-subtitle-font-size/proposal.md)（delta 為 `viewer-subtitle-display`，**0/7 tasks**）。Issue：#29。未移轉 ID：**U25**（`SYS-004` 為非 Viewer UI 關聯）。
- 實作 `CONFIRMED_IMPLEMENTED`（既有字級與 fullscreen 控制）；規格 `CHANGE_OPEN`，不能標 `CURRENT`；驗證 `S+T(ref)`，真實 iOS Safari/native fullscreen／Preview／Production `NOT_VERIFIED`。
- 未來／待決：完成 change 所列單元、瀏覽器與真機驗收，未核准前不勾 tasks／archive。證據：`src/pages/viewer/MeetingViewerPage.jsx`、`src/lib/viewerFontSizePreference.js`、`tests/e2e/meetingViewerFullscreen.spec.js`、[change tasks](../../openspec/changes/formalize-viewer-subtitle-font-size/tasks.md)。

**VIEW-003｜多網路／多 Viewer 傳輸選型**：TURN／relay 與 10／50／100 viewers 的容量及成本界線。技術模組：Viewer / WebRTC / Subtitle Sync 的擴充候選。

- OpenSpec：無；Change：無。Issue／PR：#31、#38／PR #40。未移轉 ID：**U28**。
- 實作 `DESIGN_UNDECIDED`；規格 `DECISION_PENDING`；驗證 `S(ref)`，多網路與 Preview／Production `NOT_VERIFIED`。
- 未來需求：先有網路矩陣、壓測與選型決策；不得從現有 WebRTC 程式推斷已支援規模。證據：[Phase 3C U28](../spec-audit/phase-3c-report.md)、`src/webrtc/subtitleTransport.js`。

### DATA｜資料保存與匯出

**DATA-001｜本機錄製資料保存**：在同源瀏覽器用 OPFS／IndexedDB 保留 chunk、manifest、reconciliation 與 reload 資料。技術模組：OPFS / IndexedDB。

- OpenSpec：[`local-persistence`](../../openspec/specs/local-persistence/spec.md)；Change：無。Issue／PR：#37、#38／PR #39。未移轉 ID：**U10–U12**。
- 實作 `CONFIRMED_IMPLEMENTED`；規格 `CURRENT`（4 Requirement、6 Scenario）；驗證 `S+T(ref)`，Safari／private mode／quota／Preview／Production `NOT_VERIFIED`。
- 未來／待決：任意 crash 零遺失是未採納的絕對保證，不能從局部 reconcile 測試推出。證據：`src/lib/localMeetingStorage.js`、`src/lib/localMeetingRecorder.js`、`tests/unit/localMeetingStorage.test.js`、[Phase 3C U10–U12](../spec-audit/phase-3c-report.md)。

**DATA-002｜雲端同步**：分 channel 將本機已持久化資料送至 Supabase，處理 ACK、重送與衝突。技術模組：Supabase / Cloud Sync；與 `DATA-001` 的本機所有權分開。

- OpenSpec：無；Change：無。Issue／PR：#35、#37／PR #39。未移轉 ID：**U13、U22**。
- 實作 `IMPLEMENTED_UNVERIFIED`；規格 `UNFORMALIZED`；驗證 `S+T(ref)`，migration/RLS/ACK 及 Preview／Production `NOT_VERIFIED`。
- 未來／待決：durable commit 與 ACK 一對一部署證據、offline resend；不可把 architecture 目標直接當目前已驗收行為。證據：`src/lib/cloudSaveCoordinator.js`、`tests/unit/cloudSaveCoordinator.test.js`、`tests/cloud/stagingSmoke.spec.js`、[Phase 3C U13/U22](../spec-audit/phase-3c-report.md)。

**DATA-003｜逐字稿與錄音匯出**：提供 TXT／SRT／VTT、音訊下載與 export artifact 狀態；原音擷取由 `REC-002` 擁有。技術模組：Recording / Export 的匯出側。

- OpenSpec：無；Change：無。Issue／PR：#6、#16、#38、#41／PR #17。未移轉 ID：**U23**（U14 主歸 `REC-002`）。
- 實作 `CONFIRMED_IMPLEMENTED`；規格 `UNFORMALIZED`；驗證 `S+T(ref)`，現行產品 WebM／Preview／Production `NOT_VERIFIED`。
- 未來／待決：只可先規格化有程式與測試支援的格式／artifact state，不能把隔離 WebM 失敗寫成產品缺陷。證據：`src/lib/meetingTranscriptExport.js`、`src/application/exportArtifactService.js`、`tests/unit/exportArtifactService.test.js`、[Phase 3C U23](../spec-audit/phase-3c-report.md)。

### AUTH｜使用者與權限

**AUTH-001｜登入、授權與管理**：保護使用者、角色、帳戶狀態、管理操作及相應 server guard。技術模組：Authentication / Administration。

- OpenSpec：無；Change：無。Issue／PR：#33／PR #34。未移轉 ID：**U24**。
- 實作 `IMPLEMENTED_UNVERIFIED`；規格 `UNFORMALIZED`；驗證 `S+T(ref)`，OAuth redirect、部署 RLS 及 Preview／Production `NOT_VERIFIED`。
- 未來／待決：先界定 server guard 與雲端 RLS 的獨立驗收，不能由角色 UI 推斷資料權限。證據：`server/accessControl.js`、`server/adminService.js`、`tests/unit/adminService.test.js`、[Phase 3C U24](../spec-audit/phase-3c-report.md)。

### SYS｜系統可靠性與共用介面

**SYS-001｜音訊 PCM 緩衝**：主要擁有擷取音訊的 PCM16 轉換、capture fallback、有限 pending queue 與 provider transition drain；不定義 provider 重連或中斷音訊補轉錄。技術模組：PCM Queue / Audio Buffering。

- OpenSpec：[`audio-buffering`](../../openspec/specs/audio-buffering/spec.md)；Change：無。Issue：#5、#38、#41。未移轉 ID：**U06、U08、U09**。
- 實作 `CONFIRMED_IMPLEMENTED`；規格 `CURRENT`（4 Requirement、6 Scenario）；驗證 `S+T(ref)`，真實麥克風／長時段／Preview／Production `NOT_VERIFIED`。
- 未來／待決：committed transition、超大單一 chunk 與長時段 callback 不在已驗收範圍；不承諾「不向舊 provider replay」的絕對規則。證據：`src/lib/audio.js`、`src/lib/liveSession.js`、`tests/unit/liveSessionProviderTransition.test.js`、[Phase 3C U06/U08/U09](../spec-audit/phase-3c-report.md)。

**SYS-002｜Provider 續接與 rollover 協調**：主要擁有 provider 斷線後的重連、rollover 協調與 runtime 恢復狀態；Meeting／Session／Segment 的權威轉移及 recorder fence 仍由 `REC-001` 擁有，PCM queue 由 `SYS-001` 擁有。不保證中斷音訊零缺口。技術模組：Session Rollover / Reconnection。

- OpenSpec：無；Change：無。Issue：#3、#4、#41。未移轉 ID：**U20、U20b**。
- 實作 `IMPLEMENTED_UNVERIFIED`；規格 `UNFORMALIZED`；驗證 `S+T(ref)`，真實 GoAway/token expiry／同 build trace／Preview／Production `NOT_VERIFIED`。
- 未來／待決：#41 的 15 分鐘症狀僅 `SUSPECTED`，根因 `UNKNOWN`；不是 `CONFIRMED_DEFECT`。證據：`src/lib/reconnectController.js`、`src/lib/rolloverRecoveryCoordinator.js`、對應 unit/mock、[Phase 3C U20/U20b](../spec-audit/phase-3c-report.md)。

**SYS-003｜中斷音訊補救**：主要歸屬未來 Gap Recovery 與 #41 LAR-16～21 的補轉錄候選；跨錄音、緩衝、續接與本機保存，但不重新定義 `REC-002` 的擷取、`SYS-001` 的 queue 或 `SYS-002` 的重連契約。技術模組：PCM Queue、Rollover、Recording / Export 的未來交界。

- OpenSpec：無；Change：無。Issue：#41。未移轉 ID：**U07、U27**。
- 實作 `PLANNED`（僅見前置機制）；規格 `ROADMAP_ONLY`；驗證 `S(ref)`，零缺口、Preview／Production `NOT_VERIFIED`。
- 未來需求：先定義可量測缺口、恢復窗口與證據，另行採納；不進四份現行主規格。證據：[Phase 3C U07/U27](../spec-audit/phase-3c-report.md)、`docs/verification/issue-41-phase-a.md`。

**SYS-004｜跨頁面響應式介面**：主要擁有共用版面與非 Viewer 頁面的窄螢幕可操作性；因其橫跨產品頁面而歸 SYS 的「共用介面」，不歸音訊可靠性。Viewer 字級／fullscreen 的主要歸屬是 `VIEW-002`，不在此重複定義。技術模組：UI / RWD / Fullscreen 的非 Viewer 側。

- OpenSpec：無；Change：無。Issue：#29（現有 UI 盤點關聯）；未移轉 ID：無，U25 主歸 `VIEW-002`。
- 實作 `IMPLEMENTED_UNVERIFIED`；規格 `UNFORMALIZED`；驗證 `S+T(ref)`，真實 mobile touch/safe-area／Preview／Production `NOT_VERIFIED`。
- 未來／待決：不同頁面的可操作範圍仍須收窄，不因 CSS breakpoint 存在就視作行動裝置驗收。證據：`src/styles/`、`tests/e2e/headerResponsive.spec.js`、[功能矩陣 UI 列](../spec-audit/feature-matrix.md)。

## 待決與下一個最小 Change

1. `REC-001`：lifecycle-v1 相容行為是否仍屬正式現行契約（U04）。
2. `DATA-001`：private mode／quota／Safari 的支援與降級矩陣（U10）。
3. `AI-002`：詞彙量上限與跨端並發政策（U18）。
4. `VIEW-003`：TURN／relay 和目標 Viewer 容量，須先有多網路測量（U28）。

**下一個最小範圍 OpenSpec Change：完成既有 `formalize-viewer-subtitle-font-size` 的字級呈現驗收。** 它已有明確 Viewer-owned delta 與 7 項未勾 tasks；只針對 preference helper、Viewer 顯示／fullscreen／390px mobile 情境補證並調和不符處，不觸碰字幕傳輸、Cue 順序或主規格，也不新建平行 change。本 Registry 建立本身不核准該 change 的實作或 archive。
