# Preview／Production 部署設定

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
| `APP_ORIGIN` | 必填，各環境各自設定 | 該前端完整 HTTPS Origin，供 CORS 與 token API 使用；Preview 須對應實際網址。 |
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

`SUPABASE_PUBLISHABLE_KEY` 是後端公開 REST 讀取的可選 fallback；已有 `VITE_SUPABASE_PUBLISHABLE_KEY` 時可省略。一般 Meeting 的 Gemini API key 由 Host 在介面輸入；**不需**將 `GEMINI_API_KEY` 當作所有部署的必填項。若另外啟用獨立 Gemini 翻譯／重譯 Worker，須在後端設定 `GEMINI_API_KEY`；若呼叫 `/api/internal/worker`，另需 `CRON_SECRET` 作 Bearer 授權，可選設 `WORKER_BATCH_SIZE` 與 `SUPABASE_WORKER_USER_ID`。這些都不得放前端。

其他模型、rate limit、診斷、路徑覆寫及歷史相容變數的用途與未設行為，統一見 [環境變數盤點](development.md#環境變數盤點)。已退役 Cloud Recording、Cloud Cue、Meeting SSE 不列入雲端主要安裝清單。舊 Supabase Realtime viewer 的簽署 JWK 僅供歷史路徑，不是目前 DataChannel Viewer 的必填項。

部署前仍須以 [測試與驗收](TESTING.md)及 [WebRTC 驗證指南](verification/webrtc-browser-deployment.md)確認實際行為；請勿把 Secret、短效 token 或 TURN credential 貼到文件、CLI 輸出或提交紀錄。
