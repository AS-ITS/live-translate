# 本機安裝與 Preview／Production 部署設定

## 全新安裝：本機 Supabase

此節只操作本機服務。從儲存庫全新 clone 後，在專案根目錄執行 `npm install`；需 Node.js 22、npm、Git、Redis CLI／Server、Docker 與 Supabase CLI。先安裝並啟動 [Docker Desktop](https://docs.docker.com/desktop/)（macOS、Windows、Linux），等程式顯示已啟動，再用 `docker info` 確認 Docker daemon 可連線。第一次 `supabase start` 會下載容器映像，需要網路與足夠磁碟空間。[Supabase CLI 官方安裝說明](https://supabase.com/docs/guides/local-development/cli/getting-started)列出支援的平台與安裝方式。

### 安裝與驗證 CLI

選一種安裝方式；下文以全域 `supabase` 為例。**macOS** 使用 Homebrew：

```bash
brew install supabase/tap/supabase
supabase --version
```

**Windows** 在 PowerShell 使用 Scoop：

```powershell
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
supabase --version
```

**Linux** 可用 Homebrew 執行 `brew install supabase/tap/supabase`；或從 [Supabase CLI Releases](https://github.com/supabase/cli/releases)下載與發行版、CPU 架構相符的套件，再依套件類型執行 `sudo dpkg -i <下載檔>.deb`、`sudo rpm -i <下載檔>.rpm` 或 `sudo apk add --allow-untrusted <下載檔>.apk`。安裝後執行 `supabase --version`。

三種作業系統也可選**專案 npm 版**：

```bash
npm install --save-dev supabase
npx supabase --version
```

npm 版只安裝在此專案，後續手動 CLI 指令一律加 `npx`，例如 `npx supabase start`、`npx supabase status`、`npx supabase stop`。`package.json` 的 `db:start`／`db:stop` 本來就使用 `npx supabase`；`npm run start` 會將專案的 `node_modules/.bin` 加入 PATH，因此兩種安裝方式都可供啟動器使用。不要使用 `npm install -g supabase`。此儲存庫已有 `supabase/config.toml` 與 `supabase/migrations/`，**不要執行 `supabase init`**；本機服務也**不需要 `supabase link`**。

### 首次啟動與 migration 核對

1. 先在 Google Cloud 建立自己的 OAuth Web Client，再依[本機 Google OAuth 設定](GOOGLE_OAUTH_SETUP.md#local-google-oauth)從 `supabase/.env.example` 建立 `supabase/.env.local`，填入 `GOOGLE_CLIENT_ID` 與 `GOOGLE_CLIENT_SECRET`。公開 `config.toml` 只引用環境變數，沒有預設 Client ID。首次啟動前，macOS／Linux 執行 `chmod 600 supabase/.env.local`；Windows 請將檔案限制為目前使用者可讀，並在支援 POSIX 權限的環境執行啟動器。
2. 依 OAuth 指南將兩個變數載入目前終端，確認 `docker info` 成功後，在專案根目錄執行 `supabase start`（npm 版為 `npx supabase start`），再執行 `supabase status`。直接使用 CLI 時不應假設它會讀取 `supabase/.env.local`；也可用 `npm run start -- --check` 讓啟動器從該檔載入並啟動 Stack。第一次啟動會套用 `supabase/migrations/` 的 migration；不得把 `supabase db reset` 當成一般啟動步驟，該指令會重建本機資料庫並刪除既有資料。
3. 執行 `supabase migration list --local`，核對每個 `supabase/migrations/*.sql` 的版本在本機資料庫欄皆有對應紀錄，沒有僅存在於檔案的版本。npm 版使用 `npx supabase migration list --local`。再執行 `npm run start -- --check`；啟動器會比較 migration 檔案與 `supabase_migrations.schema_migrations` 的完整版本序列，並檢查本機 URL、Google provider 與 Redis。`--check` 可能啟動本機 Redis。若檢查失敗，先閱讀錯誤與 migration 紀錄，**不要以 `db reset` 排錯**。
4. 執行 `supabase status -o json`（npm 版加 `npx`），讀取本機 `API_URL`、`ANON_KEY`、`SERVICE_ROLE_KEY`；不要把輸出中的金鑰貼到 issue、文件或版本控制。依 [`.env.example`](../.env.example)建立根目錄 `.env`：`SUPABASE_URL` 和 `VITE_SUPABASE_URL` 使用 `API_URL`；`VITE_SUPABASE_PUBLISHABLE_KEY` 使用 `ANON_KEY`；`SUPABASE_SECRET_KEY` 使用 `SERVICE_ROLE_KEY`；`SUPABASE_JWKS_URL` 使用 `<API_URL>/auth/v1/.well-known/jwks.json`。本機 WebRTC signaling 使用 `WEBRTC_SIGNALING_REDIS_URL=redis://127.0.0.1:6379`；Redis 啟動方式見[本機開發指南](development.md)。
5. 執行 `npm run start`，開啟 `http://127.0.0.1:5173`，以自己的 Google 帳號登入並檢查頁面可載入；若要驗證會議翻譯，在 Host 介面提供自己的 Gemini API key。此步只驗證本機，不會修改 Preview 或 Production。

### 安全停止與重新啟動

先在執行 `npm run start` 的終端按 `Ctrl+C`，再執行 `supabase stop`（npm 版為 `npx supabase stop`）。保留本機資料的日常停止**不要加 `--no-backup` 或 `--all`**。下次先啟動 Docker，執行 `supabase start`、`supabase status`，確認 Redis 可用後再執行 `npm run start -- --check` 和 `npm run start`。如只需重啟應用程式，按 `Ctrl+C` 後再執行 `npm run start` 即可；不必重建資料庫。[Supabase CLI stop 說明](https://supabase.com/docs/reference/cli/supabase-stop)。

### 常見故障

| 現象 | 處理方式 |
| --- | --- |
| 顯示 `not linked` | 確認目前位於此儲存庫根目錄並使用 `supabase start`／`status`；若是 `migration list`，明確加 `--local`。本機不需 `supabase link`，不要改用遠端 migration 指令。 |
| Docker 未啟動／無法連線 | 開啟 Docker Desktop，等引擎完成啟動；`docker info` 成功後重試 `supabase start`。Linux 也要確認目前使用者有權存取 Docker daemon。 |
| Port 已占用 | `config.toml` 的 DB port 是 `54322`、Studio 是 `54323`；API 預設 `54321`，應用程式使用 `3000`／`5173`，Redis 使用 `6379`。先停止佔用該埠的其他本機服務或另一組 Supabase stack；若修改本機 port，Google callback、`.env` 和啟動器檢查必須同步核對。勿為排錯重設資料庫。 |
| migration 未全部套用 | 確認在正確的專案根目錄啟動，查 `supabase migration list --local` 與 `supabase start` 的錯誤；保留原有資料並修正失敗原因後再啟動。 |

若同一台電腦已有使用相同 `project_id` 的本機 stack，CLI 可能沿用既有資料。驗證全新安裝時，先確認沒有另一份同名專案在運行；勿為取得空白資料庫而停止或重設不屬於本次安裝的服務。

## Preview／Production

本指南列出各雲端環境必須準備的設定。Local 請依 [開發指南](development.md)使用 Local Supabase，不要用 Production URL 或 Secret 測試。Google OAuth 的建立與 callback 步驟見 [OAuth 教學](GOOGLE_OAUTH_SETUP.md)。

正式 Meeting 的PCM、音訊、Cue、Transcript、Segment、Checkpoint、Journal 與 Recovery 留在 Host 瀏覽器 OPFS／IndexedDB；Supabase 保存會議 metadata、字典、帳號、授權及必要協調資料，Viewer 由 WebRTC DataChannel 接收字幕。部署不會備份 Host 錄製內容。

目前 [RC1 驗收](TESTING.md#issue-41-rc1-acceptance-status-2026-11-09)仍有外部設定待完成；文件列出配置方式，不代表跨網路／Safari 驗收已通過。

## 各環境分開準備

1. Preview 與 Production 使用**不同** Supabase Project，分別取得 Project URL、publishable key、後端 secret key、JWKS URL。先核對對應的 migration，避免對有資料的 Project 執行本機 reset 指令。
2. 依 [OAuth 教學](GOOGLE_OAUTH_SETUP.md#preview-與-production)分別設定 Google Client、該 Project 的 `/auth/v1/callback`、Supabase provider ID／Secret、Site URL 與 Redirect URLs。
3. 各自準備 Redis **HTTPS REST** signaling URL 與 token。這不同於本機 `redis://127.0.0.1:6379` TCP URL；不得將本機 URL 當 Vercel 設定。依實際網路需求在後端配置 STUN／TURN `WEBRTC_ICE_SERVERS_JSON`；TURN credential 視為 Secret。
4. 在各自 Vercel Preview／Production 設定下表環境變數，確認 `APP_ORIGIN` 為該網站完整 Origin。正式網站範例：`https://translate.example.com`，一般 HTTPS 不必另寫 port。驗證 OAuth、`/healthz`、`/readyz`、Meeting 與 Viewer signaling；跨網路／Safari 仍需實測。

操作 migration 前，先執行 `supabase login`、`supabase link --project-ref <target-project-ref>`，人工核對 `supabase/.temp/linked-project.json`。現有 `npm run deploy:supabase` 只對**目前連結**的 Project 執行 `supabase db push --linked`，不會自行切換目標。部署前執行 `vercel login`、`vercel link` 並核對 `.vercel/project.json`；`scripts/deploy-preview.sh` 會執行 `vercel deploy --yes` 和 `npm run test:deployment-preflight`，不會建立 Supabase Project、設定 OAuth 或套用 migration。禁止對有資料的環境執行 `db:reset`。

## Vercel 環境變數清單

| 變數 | 必要性與來源 | 說明 |
| --- | --- | --- |
| `APP_ORIGIN` | 必填，各環境各自設定 | 在部署平台明確設定可信任的前端完整 HTTPS Origin，供 CORS 與 token API 使用；Preview 須對應實際網址，Production 須使用正確的正式網址。不得從請求的 Host／Origin Header 自動加入 allowlist。 |
| `SUPABASE_URL` | 必填，各環境各自設定 | 對應 Supabase Project URL，後端使用。 |
| `SUPABASE_SECRET_KEY` | 必填，**後端 Secret** | 對應 Project 的 service／secret key，不得加 `VITE_` 前綴。 |
| `SUPABASE_JWKS_URL` | 必填，後端 URL | `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`；須與同一 Project 一致。 |
| `VITE_SUPABASE_URL` | 必填，公開 | 與 `SUPABASE_URL` 指向同一 Project。 |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | 必填，公開 | 瀏覽器使用的對應 publishable／anon key。 |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | 選填 | 未設定時不限制 Google 帳號的電子郵件網域；設定後只允許指定網域登入。逗號分隔，忽略空白與大小寫；Google OAuth Audience／Testing 限制不受影響。 |
| `WEBRTC_SIGNALING_REDIS_URL` | Viewer signaling 必填 | 雲端 Redis **HTTPS REST URL**，不可使用本機 TCP URL。 |
| `WEBRTC_SIGNALING_REDIS_TOKEN` | Viewer signaling 必填，**Secret** | 對應 REST 服務 token。 |
| `WEBRTC_ICE_SERVERS_JSON` | 網路需 STUN／TURN 時條件必填 | `RTCIceServer[]` JSON；含 TURN credential 時列為 Secret。 |
| `NODE_ENV`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_BRANCH_URL` | 平台自動 | Vercel 提供環境與部署網址，無需手填；`VERCEL_BRANCH_URL` 視部署而有。 |

`SUPABASE_PUBLISHABLE_KEY` 是後端公開 REST 讀取的可選 fallback；已有 `VITE_SUPABASE_PUBLISHABLE_KEY` 時可省略。一般 Meeting 的 Gemini API key 由 Host 在介面輸入；**不需**將 `GEMINI_API_KEY` 當作所有部署的必填項。舊 `/api/internal/worker` API 及其 `CRON_SECRET` 授權檢查仍存在，但獨立 Translation Worker 已退役，相關變數不是目前部署的安裝必需項。

其他模型、rate limit、診斷、路徑覆寫及歷史相容變數的用途與未設行為，統一見 [環境變數盤點](development.md#環境變數盤點)。已退役 Cloud Recording、Cloud Cue、Meeting SSE 與舊 Realtime Viewer 不列入雲端主要安裝清單。Vercel 仍有 `SUPABASE_REALTIME_SIGNING_PRIVATE_JWK`、`SAVED_RETRANSLATION_MODEL`、`SESSION_SUMMARY_MODEL` 等歷史變數；它們不是目前 DataChannel Viewer 的必填項，移除狀態尚待確認。

部署前仍須以 [測試與驗收](TESTING.md)及 [WebRTC 驗證指南](verification/webrtc-browser-deployment.md)確認實際行為；請勿把 Secret、短效 token 或 TURN credential 貼到文件、CLI 輸出或提交紀錄。
