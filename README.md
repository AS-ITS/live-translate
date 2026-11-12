# Live Translate

Live Translate 是瀏覽器即時語音翻譯與會議字幕工具。Host 錄製與翻譯，Viewer 透過分享連結觀看即時字幕。

## 主要功能

- 建立會議、設定語言與字典，並分享 Viewer 連結或 QR code。
- 顯示原文與翻譯字幕，並在 Host 瀏覽器保存錄音與逐字稿。
- **Stop** 暫停錄製、**Continue** 繼續、**End** 完成會議；Host 可在期限內查看或匯出本機內容。

## 架構簡介

Host 瀏覽器使用後端核發的短效 token 直接連接 Gemini Live API。音訊、Cue、Transcript、Checkpoint、Journal 與 Recovery 保存在 Host 的 OPFS／IndexedDB；Supabase 保存會議 metadata、字典、帳號、授權及必要的協調資料。Viewer 透過 WebRTC DataChannel 接收字幕。詳見[架構總覽](docs/architecture/architecture-overview.md)。

## 快速安裝與啟動

1. 依[本機開發指南](docs/development.md)準備 Node.js、Docker、Supabase CLI、Redis，並完成[Google OAuth 設定](docs/GOOGLE_OAUTH_SETUP.md)。
2. 在專案根目錄執行：

   ```bash
   npm ci
   npm run start -- --check
   npm run start
   ```

3. 開啟終端顯示的 Vite 網址。Host 如要使用真實 Gemini Live 翻譯，須在介面提供該次請求使用的 API key。

`--check` 可能啟動本機 Supabase／Redis；詳見[本機開發指南](docs/development.md)。

## 文件導覽

| 想做的事 | 文件 |
| --- | --- |
| 安裝與本機開發 | [本機開發](docs/development.md) · [Google OAuth](docs/GOOGLE_OAUTH_SETUP.md) · [本機 OAuth Sample](supabase/.env.local.example) |
| 設定雲端環境 | [環境變數 Sample](.env.example) · [部署](docs/DEPLOYMENT.md) |
| 使用與驗證 | [使用指南](docs/USER_GUIDE.md) · [測試與驗收](docs/TESTING.md) |
| 理解與維護 | [架構總覽](docs/architecture/architecture-overview.md) · [API](docs/api.md) · [功能規格](docs/features/) · [貢獻指南](CONTRIBUTING.md) |

## 授權與作者

著作權標示為 Academia Sinica；授權條款見 [LICENSE](LICENSE)。
