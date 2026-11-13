# Live Translate

> 版本：1.0.0。以目前 Production 的 `12cfec5c9002da58e045a5de66b34b8ff79c7289` 為功能基準；RC1 驗收狀態與已知限制見[測試與驗收](docs/TESTING.md)。

Live Translate 是瀏覽器即時語音翻譯與會議字幕工具。Host 錄製與翻譯，Viewer 透過分享連結觀看即時字幕。

## 主要功能

- 建立會議、設定語言與字典，並分享 Viewer 連結或 QR code。
- 顯示原文與翻譯字幕，並在 Host 瀏覽器保存錄音與逐字稿。
- **Stop** 暫停錄製、**Continue** 繼續、**End** 完成會議；Host 可在期限內查看或匯出本機內容。

## 架構簡介

Host 瀏覽器使用後端核發的短效 token 直接連接 Gemini Live API。PCM、音訊、Cue、Transcript、Segment、Checkpoint、Journal 與 Recovery 保存在 Host 的 OPFS／IndexedDB；Supabase 保存會議 metadata、字典、帳號、授權及必要的協調資料。Viewer 透過 WebRTC DataChannel 接收字幕。詳見[架構總覽](docs/architecture/architecture-overview.md)。

## 快速安裝與啟動

首次安裝需 Node.js 22、npm、Git、Docker（已啟動）及 Redis CLI／Server。以下命令都在**專案根目錄**執行；各作業系統的安裝方式與排錯見[本機 Supabase 安裝指南](docs/DEPLOYMENT.md#全新安裝本機-supabase)。

1. `git clone https://github.com/pochun1021/live-translate.git`，進入 `live-translate` 後執行 `npm install`。
2. 安裝並驗證 Supabase CLI：全域安裝執行 `supabase --version`；若選擇專案 npm 版，執行 `npm install --save-dev supabase`、`npx supabase --version`。先啟動 Docker，並以 `docker info` 確認可連線。
3. 在 Google Cloud 建立自己的 OAuth Web Client，依[Google OAuth 設定](docs/GOOGLE_OAUTH_SETUP.md#local-google-oauth)將 `supabase/.env.example` 複製為 `supabase/.env.local`，填入 `GOOGLE_CLIENT_ID` 與 `GOOGLE_CLIENT_SECRET`，並讓 CLI 讀到這兩個變數；再執行 `supabase start`、`supabase status`，npm 版則加 `npx`。未設定時啟動器會停止並提示設定；此專案已有 `supabase/config.toml`，無須 `supabase init` 或 `supabase link`。
4. 以 `supabase migration list --local`（npm 版為 `npx supabase migration list --local`）核對所有本機 migration 均已套用；從 `supabase status -o json` 取得 `API_URL`、`ANON_KEY`、`SERVICE_ROLE_KEY`，依[本機環境變數範例](.env.example)建立 `.env`。金鑰只留在本機，不要提交。
5. 啟動 Redis，執行 `npm run start -- --check`，確認 Docker、Supabase、OAuth、migration 與 Redis 檢查通過，再執行 `npm run start`，開啟 `http://127.0.0.1:5173` 登入並驗證頁面。Host 使用真實 Gemini Live 翻譯時，須在介面提供該次請求的 API key。

`--check` 在 Supabase 尚未啟動時也可能啟動本機 Supabase，並可能啟動 Redis；完整停止與重新啟動方式見[本機 Supabase 安裝指南](docs/DEPLOYMENT.md#安全停止與重新啟動)。

## 文件導覽

| 想做的事 | 文件 |
| --- | --- |
| 安裝與本機開發 | [本機開發](docs/development.md) · [Google OAuth](docs/GOOGLE_OAUTH_SETUP.md) · [本機 OAuth 範本](supabase/.env.example) |
| 手動啟動 Dev Server | [本機環境變數 Sample](.env.example) · [本機開發](docs/development.md#方式-b手動-dev-server) |
| 設定雲端環境 | [部署](docs/DEPLOYMENT.md) |
| 使用與驗證 | [使用指南](docs/USER_GUIDE.md) · [測試與驗收](docs/TESTING.md) |
| 理解與維護 | [架構總覽](docs/architecture/architecture-overview.md) · [API](docs/api.md) · [功能規格](docs/features/) · [貢獻指南](CONTRIBUTING.md) |

`AUTH_ALLOWED_EMAIL_DOMAINS` 為選填。未設定時不限制 Google 帳號的電子郵件網域；設定後只允許指定網域登入。Google OAuth Audience／Testing 限制仍由 Google 控制；設定方式見[本機開發指南](docs/development.md#環境變數盤點)。

## 作者與授權

- 作者暨維護者：Po-Chun Ruan（阮柏鈞），Academia Sinica（中央研究院）。
- 著作權人：Academia Sinica。
- 授權：MIT，詳見 [LICENSE](LICENSE)。
- 儲存庫：[pochun1021/live-translate](https://github.com/pochun1021/live-translate)。
