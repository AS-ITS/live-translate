# 本機安裝與 Preview／Production 部署設定

## 全新安裝：本機 Supabase

本節只使用已提交的 `supabase/config.toml` 與 `supabase/migrations/`，不需 `supabase init` 或 `supabase link`。需要 Node.js 22、npm、Git、Docker 與 Supabase CLI。第一次啟動會下載 Docker 映像；請先確認 Docker daemon 可連線。

| 系統 | Docker | 全域 Supabase CLI |
| --- | --- | --- |
| Windows 10／11 | 安裝並啟動 [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)（Linux containers） | 依 [Supabase CLI 安裝說明](https://supabase.com/docs/guides/local-development/cli/getting-started)使用 Scoop |
| Ubuntu／Debian | 安裝並啟動 [Docker Engine](https://docs.docker.com/engine/install/) 或 [Docker Desktop for Linux](https://docs.docker.com/desktop/setup/install/linux/) | 依官方說明安裝 Linux 套件或 Homebrew 版本 |
| macOS Apple Silicon／Intel | 安裝並啟動 [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/) | `brew install supabase/tap/supabase` |

若已安裝 Scoop，Windows PowerShell 執行 `scoop bucket add supabase https://github.com/supabase/scoop-bucket.git`、`scoop install supabase`。若 Ubuntu／Debian 已安裝 Homebrew，可執行 `brew install supabase/tap/supabase`；其他 Linux 安裝方式見 [Supabase CLI Releases](https://github.com/supabase/cli/releases)與官方安裝說明，下載對應架構的 `.deb` 後執行 `sudo dpkg -i <下載的檔名>.deb`。macOS Terminal 執行 `brew install supabase/tap/supabase`。Docker 依表中的官方安裝頁完成安裝並啟動 daemon，再執行下列驗證命令。

三平台均在專案根目錄執行 `docker info` 與 `supabase --version` 確認安裝。也可使用專案 npm 版 `npm install --save-dev supabase`；其 CLI 由 `npx supabase` 執行，啟動器會從 npm 提供的 `node_modules/.bin` 尋找它。請勿使用 `npm install -g supabase`。

### Windows PowerShell

```powershell
git clone https://github.com/pochun1021/live-translate.git
Set-Location live-translate
npm ci
Copy-Item supabase/.env.example supabase/.env.local
# 編輯私人檔案，填入自己的 GOOGLE_CLIENT_ID 與 GOOGLE_CLIENT_SECRET
# 依 Google OAuth 指南檢查並限制 NTFS ACL；不要用 chmod 600
docker info
supabase --version
docker run -d --name live-translate-redis -p 127.0.0.1:6379:6379 redis:7-alpine
npm run start -- --check
supabase status
npm run start
```

### Ubuntu／Debian Bash 與 macOS Terminal

```bash
git clone https://github.com/pochun1021/live-translate.git
cd live-translate
npm ci
cp supabase/.env.example supabase/.env.local
# 編輯私人檔案，填入自己的 GOOGLE_CLIENT_ID 與 GOOGLE_CLIENT_SECRET
chmod 600 supabase/.env.local
docker info
supabase --version
docker run -d --name live-translate-redis -p 127.0.0.1:6379:6379 redis:7-alpine
npm run start -- --check
supabase status
npm run start
```

`docker run` 只在尚無 loopback Redis 時執行；已有 Redis 可略過。依[Redis 官方安裝說明](https://redis.io/docs/latest/operate/oss_and_stack/install/install-stack/)也可在 macOS／Linux 安裝原生 Redis。Windows 請使用 Docker Redis。`npm run start -- --check` 與正常啟動共用檢查流程，會在必要時呼叫 `supabase start`，並以 `supabase status` 取得本機 URL／金鑰；它不是純唯讀命令。不要公開 `supabase status` 的金鑰輸出。

啟動器會比較資料庫已套用版本與儲存庫的 54 個 migration；版本不同時會停止，**不會重設或遷移既有資料庫**。新資料庫的 54 個 migration 由 Supabase CLI 首次 `start` 套用。若需要手動執行 CLI，請先在目前終端載入自己的 OAuth 變數，或直接使用啟動器代為注入；不要把憑證寫進命令歷史。

本機安裝預設不限制 Google 帳號的 Email 網域。如有組織使用需求，可自行設定允許的網域。`npm run start` 只採用啟動終端明確設定的 `AUTH_ALLOWED_EMAIL_DOMAINS`；空白或未設定時不限制網域，設定後由後端嚴格檢查。Preview／Production 的設定各自獨立。

### 安全停止與重新啟動

以 Ctrl+C 結束 `npm run start` 啟動的 API 與 Vite；本機 Supabase 與 Redis 不會因此被重設。下次先啟動 Docker，再執行 `npm run start -- --check` 與 `npm run start`。不要在既有資料庫執行 `npm run db:reset`。

### 常見故障

- `Create supabase/.env.local`：看錯誤中的 `Expected path`，確認執行的 clone 與私人檔案位於同一專案；路徑含空白或中文可用。
- `not readable`／`mode 600`：macOS／Linux 檢查檔案擁有者並執行 `chmod 600 supabase/.env.local`。
- Windows ACL 錯誤：用 `Get-Acl .\supabase\.env.local | Format-List` 與 `icacls .\supabase\.env.local` 檢查。限制繼承及廣泛群組的讀取權；啟動器只自動辨識常見廣泛群組，仍須人工檢查自訂群組。
- `docker info`／`supabase status` 失敗：確認 Docker 已啟動、Supabase CLI 在 PATH，並使用此儲存庫的 `supabase/config.toml`。
- Redis 不可用：確認 `127.0.0.1:6379` 有 Docker Redis 或原生 Redis；不要把 Redis 暴露到公網。

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
