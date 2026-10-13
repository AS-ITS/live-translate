# Live Translate OpenSpec Phase 3B：現行規格基線移轉報告

日期：2026-10-13（Asia/Taipei）。審查基線：Git HEAD `50b3d87`；本階段開始前即有未提交的 `CHANGELOG.md`、`docs/features/audio-device-selection.md`、`tests/e2e/liveTranslate.spec.js` 與未追蹤 `.agents/`。本階段未修改、暫存或提交這些檔案。

## 範圍與分類閘門

已完整複核 `baseline-review.md`、`system-inventory.md`、`feature-matrix.md`、`known-gaps.md`、`roadmap-candidates.md`、`openspec-migration-plan.md`。Phase 3A 兩項退回分類維持：#41 的 15 分鐘 provider 症狀為 `SUSPECTED`，真實 rollover 根因與 Preview/Production 均 `NOT_VERIFIED`；非初始 WebM slice `EncodingError` 與 60 秒 rotation −25.33 ms 僅為 Headless Chromium/macOS 隔離實驗的 `REPRODUCED_IN_TEST`。四份新 spec 均未把這些問題、Gap Recovery 或測試通過改寫成 Production 已驗的 SHALL。

Phase 3A 的四組 Scenario 是**候選**，不是先前已生效的主規格。本階段依現行 source 與測試逐條收窄後才採納；未採納的候選列在下方。程式證據以本工作樹源碼為主，測試檔只證明有相應自動化斷言，本階段未重跑產品測試。

## 實際建立的規格

| 主規格 | Requirement | Scenario | 已採納契約與逐項證據位置 | 驗證環境 |
|---|---:|---:|---|---|
| `openspec/specs/meeting-lifecycle/spec.md` | 3 | 5 | lifecycle-v2 的 open Session／active Segment 唯一性、operation replay/version guard、recorder fence；規格內 `Evidence by Requirement` 對應 lifecycle SQL migrations、Supabase adapter、migration/unit/HTTP tests。 | SQL 靜態檢查、unit/HTTP mock；部署 DB 未驗 |
| `openspec/specs/audio-buffering/spec.md` | 4 | 6 | 16 kHz/100 ms PCM16 與 partial flush、Worklet fallback、有界 pre-roll、provider-ready／pre-commit cancel drain；對應 `audio.js`、`liveSession.js`、audio/transition/failure unit tests。 | unit/mock；真實裝置與 provider 未驗 |
| `openspec/specs/local-persistence/spec.md` | 4 | 6 | reserve→write→seal、衝突重試、reconciliation、同源 reload、credential-shaped projection；對應 local recorder/storage/persistence source 及 unit/Headless Chromium tests。 | unit/Headless Chromium；Safari/private/quota/部署未驗 |
| `openspec/specs/translation-glossary/spec.md` | 4 | 6 | deterministic revision、Meeting override、authoritative Segment provider snapshot、stable Turn correction revision；對應 glossary/token source 及 revision/merge/Continue/correction unit tests。 | unit/mock token；真實 Gemini 與部署未驗 |

合計 **15 個 Requirement、23 個 Given/When/Then Scenario**。每個 Requirement 在其規格的 `Evidence by Requirement` 有一對一的實作與測試對照；規格末尾的 `Known Limits and Unverified Conditions` 限定證據外推範圍。Issue/PR 仍僅供 `feature-matrix.md` 追溯，不被當成現行行為證據。

## 未移轉或收窄的項目

1. **Meeting Lifecycle**：Preview/Production migration head、RLS、真實並發 lease/takeover、retention/physical deletion 與 lifecycle-v1 相容細節未納入本次 SHALL。SQL replay 有明確程式證據，但沒有目前部署 DB 的通過記錄。
2. **Audio Buffering**：Phase 3A 候選「不向舊 provider replay」過於籠統。`liveSessionProviderTransition.test.js` 證明未提交轉換取消時會向舊 provider drain 一次；本規格只採納這個有條件路徑，不主張已提交切換或 Gap Recovery 無缺口。超過佇列 byte capacity 的單一 chunk、長時段與真機音訊也未納入保證。
3. **Local Persistence**：OPFS quota/offline/private-mode、跨 tab 壓力、任意 crash 後零遺失、雲端 ACK 與 WebM 解碼未有足夠驗收，不移轉。隔離 WebM 失敗保留在 `known-gaps.md`，未寫成現行 recorder 缺陷或期望行為。
4. **Translation Glossary**：global/Meeting CRUD 與 CSV/JSON/XLSX import 路由有程式及 mock HTTP 測試，但完整 persistence/invalid-row 語意未在本次逐條建立，因此暫不形成主規格 Requirement。Gemini instruction 遵循率、詞彙量上限、並發編輯亦未驗。
5. **其他模組**：Viewer Subtitle Sync、Session Rollover / Reconnection、Gemini Live、Supabase / Cloud Sync、Recording / Export、Authentication / Administration、UI / RWD / Fullscreen 尚未在 Phase 3B 建立主規格。`formalize-viewer-subtitle-font-size` change 保留原狀，七個 tasks 仍未勾選，未 sync/archive。

未來 Transcribe Live + Flash pipeline、Issue #41 LAR-16～21、TURN/relay 選型與無損長錄音等需求仍留在 roadmap／change／Issue，沒有移入上述現行主規格。

## 驗證結果

- `openspec validate --specs --strict --no-interactive`：**4 passed, 0 failed**。首次檢查因 Requirement 區塊包含過長證據文字而有四份 warning；將證據移到一對一的 `Evidence by Requirement` 區後複驗通過，沒有放寬規範句或刪除 Scenario。
- `openspec validate --changes --strict --no-interactive`：Viewer change **1 passed, 0 failed**。
- 機械檢查：四份規格各自的 Requirement 數等於證據對照數，23 個 Scenario 均有 Given/When/Then；全部明示的 repo-relative 證據路徑存在。`openspec validate --all --strict --no-interactive` 最終為 **5 passed, 0 failed**（四份主規格加 Viewer change）。
- Git 範圍：`git diff --name-only` 仍僅列出本階段開始前的三個使用者修改；`git diff --cached --name-only` 為空，Viewer change 的 `git diff` 為空。新增檔案僅四份主規格與本報告；`.agents/` 仍未追蹤且未碰觸。
- 未跑產品 unit/E2E/真實 Gemini/雲端測試；以上 strict validation 不代表 Preview 或 Production 驗收。本階段沒有產品程式碼異動。

## 後續移轉建議

下一批先處理 **Viewer Subtitle Sync**，把 transport/snapshot/replay 與尚未完成的字級 display change 分開。再處理 **Session Rollover / Reconnection**，先取得同 build Recorder/Viewer 成對 trace 和 provider 真實驗證，僅移轉確認的 state/fence 契約。其後是 **Gemini Live** 與 **Supabase / Cloud Sync**，分別補真實 provider 與部署 migration/RLS 證據；Recording/Export 等其餘模組再按 `baseline-review.md` 的順序小批審核。

停止點：未提交 Git、未部署、未 archive、未勾選 Viewer tasks，未修改產品程式碼、API、資料庫、測試或部署設定。
