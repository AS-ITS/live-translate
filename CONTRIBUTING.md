# Contributing

## 開發流程

1. 閱讀 [AGENTS.md](AGENTS.md)、[產品規格](docs/spec.md)與[架構總覽](docs/architecture/architecture-overview.md)。
2. 查閱 [ROADMAP](docs/ROADMAP.md)和現有的 `docs/features/` 規格，確認任務範圍。
3. 以最小變更實作；行為改變時更新相關文件，能力或里程碑完成時更新 [CHANGELOG](CHANGELOG.md)。
4. 依[測試指南](docs/TESTING.md)執行最小相關測試並回報結果。

## 現行契約

Meeting 錄製內容由 Host 的 OPFS／IndexedDB 保存；Supabase 僅保存 metadata、設定、授權與必要協調資料；Viewer 字幕由 WebRTC DataChannel 傳送。請勿將歷史雲端 Cue、錄音、SSE 或 Recording Worker 路徑重新接入正式 Meeting 流程。其他獨立的翻譯執行能力，以其現有文件與程式碼為準。

保護 `/api/live-token` 的授權、來源及速率限制。不得將 `GEMINI_API_KEY`、使用者提供的 Gemini key 或短效 token 寫入前端、日誌或 Git。真實 Gemini 測試僅在明確啟用 `ENABLE_REAL_GEMINI_TEST=true` 時執行。

開發環境、測試與部署的具體流程分別見[開發指南](docs/development.md)、[測試指南](docs/TESTING.md)及[部署指南](docs/DEPLOYMENT.md)。
