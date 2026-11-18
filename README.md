# Live Translate

> 版本：1.0.0。以目前 Production 的 `12cfec5c9002da58e045a5de66b34b8ff79c7289` 為功能基準；RC1 驗收狀態與已知限制見[測試與驗收](docs/TESTING.md)。

Live Translate 是瀏覽器即時語音翻譯與會議字幕工具。Host 錄製與翻譯，Viewer 透過分享連結觀看即時字幕。

## 主要功能

- 建立會議、設定語言與字典，並分享 Viewer 連結或 QR code。
- 顯示原文與翻譯字幕，並在 Host 瀏覽器保存錄音與逐字稿。
- **Stop** 暫停錄製、**Continue** 繼續、**End** 完成會議；Host 可在期限內查看或匯出本機內容。

## 架構簡介

Host 瀏覽器使用後端核發的短效 token 直接連接 Gemini Live API。PCM、音訊、Cue、Transcript、Segment、Checkpoint、Journal 與 Recovery 保存在 Host 的 OPFS／IndexedDB；Supabase 保存會議 metadata、字典、帳號、授權及必要的協調資料。Viewer 透過 WebRTC DataChannel 接收字幕。詳見[架構總覽](docs/architecture/architecture-overview.md)。

## 快速安裝（本機部署）

以下步驟適用於 Windows、macOS 與 Linux。需要 Git、Node.js 22、npm、已啟動的 Docker，以及全域安裝的 Supabase CLI；Redis 使用 Docker 容器。安裝工具可參閱 [Git](https://git-scm.com/)、[Docker Desktop](https://www.docker.com/products/docker-desktop/)（Linux 可使用 Docker Engine）、[Node.js](https://nodejs.org/) 與 [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)。

### 1. 檢查必要工具

在終端機執行，確認所有指令成功，且 Docker 已啟動：

```bash
git --version
node --version
npm --version
docker info
supabase --version
```

### 2. 下載專案

```bash
git clone https://github.com/AS-ITS/live-translate.git
cd live-translate
```

如果已在專案目錄，可略過這一步。

### 3. 設定 Google OAuth

macOS／Linux：

```bash
cp supabase/.env.example supabase/.env.local
chmod 600 supabase/.env.local
```

Windows PowerShell：

```powershell
Copy-Item supabase/.env.example supabase/.env.local
```

編輯 `supabase/.env.local`，填入自己建立的 `GOOGLE_CLIENT_ID` 與 `GOOGLE_CLIENT_SECRET`。Google Cloud Console 中的 OAuth Client 必須設定授權重新導向 URI；Windows 也需限制此檔案的 NTFS ACL。詳見 [Google OAuth 設定指南](docs/GOOGLE_OAUTH_SETUP.md#local-google-oauth)。

### 4. 設定應用程式環境變數

若要手動啟動 API／前端，先複製根目錄範本。macOS／Linux 使用 `cp .env.example .env`；Windows PowerShell 使用 `Copy-Item .env.example .env`。依範本填入本機 Supabase URL、API Key 與所需的 Gemini 設定。本機 Redis 設定採用範本值：

```dotenv
WEBRTC_SIGNALING_REDIS_URL=redis://127.0.0.1:6379
```

`npm run start` 會從本機 Supabase 取得 URL／金鑰並設定 Redis URL，不會使用根目錄 `.env` 作為這些值的來源。`npm run start`、`npm run start -- --check` 與 `npm run db:start` 都會讀取 `supabase/.env.local`，檢查執行中的 Auth 容器 Google OAuth 設定；設定一致時沿用服務，不一致時透過 Supabase CLI 停止並重新啟動本機服務，保留資料。若無法驗證重啟後的設定，啟動會中止。`npm run db:start` 只檢查本機 Supabase 與 OAuth，不會啟動應用程式；手動啟動方式見 [本機開發指南](docs/development.md#方式-b手動-dev-server)。請勿使用他人的 Supabase、Google OAuth 憑證或正式環境 Secret。

### 5. 安裝專案依賴

```bash
npm ci
```

### 6. 啟動 Redis

首次建立容器時執行：

```bash
docker run -d --name live-translate-redis -p 127.0.0.1:6379:6379 redis:7-alpine
docker exec live-translate-redis redis-cli ping
```

`ping` 應回傳 `PONG`。如果容器已建立但已停止，執行 `docker start live-translate-redis`，再檢查 `ping`。若已有可用的本機 Redis，無需再建立容器。

### 7. 檢查本機環境

```bash
npm run start -- --check
```

依結果修正缺少的設定或服務。此檢查會視需要啟動本機 Supabase，並驗證資料庫 migration、Google OAuth 與 Redis；不是純唯讀指令。

### 8. 啟動系統

```bash
npm run start
```

用終端機顯示的本機網址開啟系統，透過 Google OAuth 登入，並允許瀏覽器使用麥克風。

`.env` 與 `supabase/.env.local` 含敏感設定，請勿提交至 Git。本機資料庫應與正式 Supabase 專案隔離；會議音訊、字幕與本機逐字稿仍保存在 Host 瀏覽器。啟動失敗時，先檢查 Docker、Redis、Supabase、環境變數與終端機錯誤訊息。更多設定與排錯方式見 [部署指南](docs/DEPLOYMENT.md)。

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
- 儲存庫：[AS-ITS/live-translate](https://github.com/AS-ITS/live-translate.git)。
