# ROADMAP

## 目前狀態

Phase 1 Demo 已完成。專案已具備多項 Phase 2 內部工具能力；新建 Meeting 的正式錄製路徑是 Host Local-only：內容保存於 OPFS／IndexedDB，Supabase 只保存 metadata、設定、授權及必要協調資料，Viewer 透過 WebRTC DataChannel 接收字幕。已完成工作的時間序列見 [CHANGELOG](../CHANGELOG.md)，現行契約見[架構總覽](architecture/architecture-overview.md)。

Issue #41 的 RC1 驗收仍有未通過或未完成項目；不得將實作完成等同於發佈通過。具體證據、手動驗收契約與未解決缺口見 [TESTING](TESTING.md#issue-41-rc1-acceptance-status-2026-11-09)。

## 接續工作

1. 完成 RC1 未通過項目的根因分析與定向驗證，包括 RAM 判定、mobile WebKit 流程及實機 WebRTC／OAuth 驗收。
2. 對已選定的 Phase 2 能力，以現有 [feature specs](features/) 和[內部工具規格](phase2-internal-tool-spec.md)確認範圍後，逐項實作與驗證。
3. Phase 3 Production、部署及其他新能力僅在明確提出需求並通過設計決策後進行。

## 範圍原則

- 不把歷史 Cloud Recording、Cloud Cue、Recording Worker 或 Meeting SSE 設計視為現行產品路徑。
- 保存正式 Meeting 的 Host 本機資料權威、Supabase metadata-only 邊界及 Viewer WebRTC 傳遞方式。
- 新功能、架構、安全模型與 API 變更遵循 [AGENTS.md](../AGENTS.md) 的決策門檻；不依舊里程碑敘述自動擴大範圍。
