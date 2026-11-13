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

需要 Node.js 22、Git、npm、已啟動的 Docker，以及全域 Supabase CLI。安裝方式見[本機安裝指南](docs/DEPLOYMENT.md#全新安裝本機-supabase)。此儲存庫已提交 `supabase/config.toml` 與 54 個 migration；不需 `supabase init` 或 `supabase link`。

Windows 10／11 PowerShell（在專案根目錄執行）：

```powershell
git clone https://github.com/pochun1021/live-translate.git
Set-Location live-translate
npm ci
Copy-Item supabase/.env.example supabase/.env.local
# 填入自己的 GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET，並依 OAuth 指南限制 NTFS ACL
docker info
supabase --version
docker run -d --name live-translate-redis -p 127.0.0.1:6379:6379 redis:7-alpine
npm run start -- --check
npm run start
```

Linux Bash／macOS Terminal：

```bash
git clone https://github.com/pochun1021/live-translate.git
cd live-translate
npm ci
cp supabase/.env.example supabase/.env.local
# 填入自己的 GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET
chmod 600 supabase/.env.local
docker info
supabase --version
docker run -d --name live-translate-redis -p 127.0.0.1:6379:6379 redis:7-alpine
npm run start -- --check
npm run start
```

`docker run` 只需在本機尚無 Redis 時執行一次；已有可用的 loopback Redis 可略過。啟動器會使用私人 OAuth 檔案啟動或檢查本機 Supabase，再啟動 API 與 Vite。Google Cloud OAuth redirect URI、NTFS ACL 與故障排查見[Google OAuth 指南](docs/GOOGLE_OAUTH_SETUP.md#local-google-oauth)和[本機開發指南](docs/development.md)。

本機安裝預設不限制 Google 帳號的 Email 網域。如有組織使用需求，可自行設定允許的網域。此設定只決定已驗證帳號能否通過後端網域檢查；角色、Meeting Ownership 與 RLS 仍會執行。

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
