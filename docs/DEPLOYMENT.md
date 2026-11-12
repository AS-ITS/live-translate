# Live Translate 部署指南

正式 Meeting 採 Host Local-only：PCM、原音／翻譯音訊、Cue、Transcript、Checkpoint、Journal、Recovery 留在 Host 瀏覽器 OPFS／IndexedDB。Supabase 保存 Meeting metadata、設定、字典、授權及必要協調 metadata；Viewer 透過 WebRTC DataChannel 收字幕。部署不會備份 Host 錄製內容。[RC1 驗收](TESTING.md#issue-41-rc1-acceptance-status-2026-11-09) 仍為 `RC1_RELEASE_VERDICT=BLOCKED`，以下步驟不是 Production 上線核准。

**外部設定狀態：BLOCKED。** 本輪只核對程式碼、範例變數與腳本，尚未核實實際 Supabase 專案、Google OAuth client、Auth URL Configuration、Redis／TURN 或 Vercel 專案中的設定；部署操作者須逐項核對後才能判定環境就緒。

## 首次部署前置步驟

Preview 與 Production 的 Google Cloud Client、Supabase Auth URL、Vercel 環境對應及登入驗證，依 [Google OAuth 安裝指南的雲端章節](GOOGLE_OAUTH_SETUP.md#5-previewproduction各環境分開配置)逐環境設定。

1. 安裝專案依賴、Supabase CLI、Vercel CLI，確認擁有目標專案權限。建立**分離**的 Preview 與 Production Supabase 專案，分別取得 project ref、Project URL、publishable key、server-only secret key 與 Auth JWKS URL；不得將 secret 寫入版控或報告。依 [Supabase Google 登入設定](https://supabase.com/docs/guides/auth/social-sign-in/auth-google) 在 Google Cloud 建立 Web OAuth client，將各 Supabase 專案的 `/auth/v1/callback` 列為 Google authorized redirect URI，並在對應 Supabase Auth Google provider 設定 client ID／secret。Local 使用 `supabase/config.toml` 所列 client ID 與 `supabase/.env.local` 的 `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET`（檔案權限 `600`）。
2. 在每個 Supabase 專案的 [Auth URL Configuration](https://supabase.com/docs/guides/auth/redirect-urls) 設定該環境 Site URL 與 Redirect URLs。Local 依 `supabase/config.toml` 使用 `http://127.0.0.1:5173`；Preview 使用實際 Preview URL；Production 使用正式網址。應用程式 OAuth 回跳網址須在允許清單內，Production 優先使用精確網址。Google OAuth callback（Supabase URL）與登入後 redirect（應用程式 URL）是不同設定。
3. 在專案根目錄執行 `supabase login`、`supabase link --project-ref <target-project-ref>`。人工核對 `supabase/.temp/linked-project.json` 的 ref、名稱與環境，再執行 migration。 `npm run deploy:supabase` 只會對**目前連結**的專案執行 `supabase db push --linked`，不會切換目標。禁止對有資料的環境執行 `db:reset`。
4. 執行 `vercel login`、`vercel link`，核對 `.vercel/project.json` 是本次 Vercel 專案。在 Vercel 專案分別設定 Preview／Production 環境變數（下表），不可帶入 Local loopback 值。`scripts/deploy-preview.sh` 會檢查 CLI 登入與連結，執行 `vercel deploy --yes`，再對部署 URL 執行 `npm run test:deployment-preflight`；它不會建立 Supabase 專案、設定 OAuth 或套用 migration。
5. 為 Preview／Production 分別準備可用的 Redis HTTPS REST signaling 服務，取得各自 URL／token；按網路需求準備 STUN／TURN 並將 ICE 設定放在 server-only `WEBRTC_ICE_SERVERS_JSON`。確認 Origin、OAuth redirect、授權網域及 Vercel 環境變數對應同一目標後才部署。跨網路／Safari 仍須實機驗收，不因設定完成而變成 PASS。

## 環境與設定

根目錄 [`.env.example`](../.env.example) 是 Preview／Production 變數的唯一完整 Sample：分別在 Vercel Preview 與 Production 設定對應值，勿將 Sample 中的空白 secret 當成已配置，也勿在兩環境共用 Supabase key。`NODE_ENV`、`VERCEL_ENV`、`VERCEL_URL` 與適用時的 `VERCEL_BRANCH_URL` 由平台提供，不必手填。Local Google OAuth 僅參照 [`supabase/.env.local.example`](../supabase/.env.local.example)；Local Client Secret 放在 Git 忽略的 `supabase/.env.local`，執行 `chmod 600 supabase/.env.local`。雲端 Google Client Secret 則放在**各自 Supabase Auth Google provider**，不放在 Vercel 或前端 `VITE_` 變數。

本機使用 `npm run start -- --check`、`npm run start`；啟動器從 Supabase CLI 產生本機 URL、publishable key 與 server-only key，無需根目錄 `.env`。請勿把 Production Supabase URL／key 放入 Local。本節下表僅列部署時需要特別核對的邊界，完整選填設定見 Sample。

| 環境 | Supabase／Vercel | 邊界 |
| --- | --- | --- |
| Local | 本機 Docker、Supabase CLI、loopback Redis；`npm run start:local -- --check` 後 `npm run start:local`。 | `scripts/start-local.mjs` 覆蓋雲端 Supabase 值並清空後端 Gemini key；詳見[開發指南](development.md)。 |
| Preview | 專用 Supabase 專案／分支、Vercel Preview 設定、測試帳號與資料。 | 核對 project ref、Auth redirect、Origin、授權網域及 WebRTC／TURN；不可使用 Production secret。 |
| Production | 與 Preview 分離的 Supabase 專案與 Vercel Production 設定。 | 上線前仍需 RC1 Gate 與實機驗收；不得由 Local 或 Preview 連結誤指向 Production。 |

變數名稱依 [`.env.example`](../.env.example)、`scripts/start-local.mjs`、`server/index.js`、兩個部署腳本核對：

| 類別 | 變數 | 設定規則 |
| --- | --- | --- |
| Supabase server-only | `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL` | 指向同一環境；secret 只放後端。`/readyz` 會檢查 Supabase 設定一致性。 |
| 瀏覽器可見 | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | 只放對應環境的 URL 與 publishable key，絕不放 service key 或私鑰。 |
| 身分與來源 | `AUTH_ALLOWED_EMAIL_DOMAINS`, `APP_ORIGIN` | 設為核准登入網域與站點來源；保留 `/api/live-token` 授權、速率限制與 Origin 檢查。 |
| Viewer signaling | `WEBRTC_SIGNALING_REDIS_URL`, `WEBRTC_SIGNALING_REDIS_TOKEN`, `WEBRTC_ICE_SERVERS_JSON` | Vercel signaling 使用 Redis HTTPS REST；ICE／TURN credential 僅在 server 端。跨網路須實機驗證。詳見 [WebRTC runbook](verification/webrtc-browser-deployment.md)。 |
| 非 Live 後端能力 | `GEMINI_API_KEY` | 只在相應 server-only 能力需要時設定。Live 錄製使用錄製者請求範圍的 Gemini key，不將長效 key 放入 `VITE_` 值。 |

`SUPABASE_REALTIME_SIGNING_PRIVATE_JWK` 等舊／其他能力設定不是現行 Viewer DataChannel 字幕來源。不要在文件、CLI 輸出、截圖或 log 公開 access token、share code、private key、TURN credential 或 API key。

## Migration 與 Preview 部署

1. 在已核對的 Local 或獨立 Preview 目標檢查 migration 與相容性。`npm run db:reset` 僅可用於可拋棄的空白 Local 資料，不可用於既有會議或長測資料。
2. 確認 Supabase CLI 連結的 project ref 與名稱後執行 `npm run deploy:supabase`。此命令會寫入目前連結的資料庫，腳本不保證目標是 Preview。
3. 確認 Vercel CLI 登入、專案連結、環境變數與 OAuth redirect 後執行 `npm run deploy:preview`。腳本保留 `vercel deploy --yes` 與部署後 preflight；失敗不能視為通過。
4. 另外檢查 `/healthz`、`/readyz`、登入、Meeting Host／Viewer DataChannel 及跨網路 TURN。未完成的 Safari 實機與 RC1 Gate 仍按 [TESTING](TESTING.md) 判定。`vercel.json` 定義 API 路由；部署不會把 Host 錄音上傳或還原。事故檢查參見[觀測 Runbook](observability-runbook.md)。

## 基本回退原則

Preview／Production 發現問題時先停止推進流量並保留證據；應用程式可回到前一個已驗證部署。資料庫 migration 可能不可逆，未評估相容性前不得降版或 reset，優先採用相容的前向修復。重新部署不會將 Host 的本機內容搬到 Supabase，也無法替其他裝置還原錄音。

## 授權

著作權人與授權文字尚待確認；未追蹤的 `LICENSE` 草稿不屬於本輪修訂。對外散布前須確認權利人與授權。第三方套件與服務另依其條款。
