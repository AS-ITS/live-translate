# Live Translate 部署指南

本文件說明目前 **Local-only 錄製內容** 的環境邊界。Vercel／Supabase 部署只處理應用程式、會議設定、字典、授權與連線協調；Host 的 PCM、音訊、Cue、Transcript、Checkpoint、Journal、Recovery 留在 Host 瀏覽器 OPFS／IndexedDB。Viewer 由 WebRTC DataChannel 取得即時字幕，不從雲端下載其他 Host 的錄製內容。部署前先讀[現行架構](architecture/architecture-overview.md#現行正式產品架構local-only)與[RC1 狀態](TESTING.md#issue-41-rc1-acceptance-status-2026-11-09)；目前 `RC1_RELEASE_VERDICT=BLOCKED`，本指南不代表 Production 上線核准。

## 環境隔離

| 環境 | Supabase 與用途 | 操作邊界 |
| --- | --- | --- |
| Local | 本機 Docker／Supabase CLI，loopback Redis；正式本機啟動器固定使用本專案目錄與 loopback URL。 | 不連至 Preview 或 Production；既有長測資料不可 reset。 |
| Preview | 獨立 Supabase 分支／測試專案與 Vercel Preview 環境。 | 只用測試身分與測試資料；核對 Vercel 專案、Supabase ref、Origin、授權網域。 |
| Production | 與 Preview 分離的 Supabase 專案及 Vercel Production 設定。 | 變更須另行審核；不得由 Local 的預設指令、連結或環境變數導向 Production。 |

每個環境的 Supabase URL、JWKS、公開 key、server secret、OAuth 與 Redis／TURN 設定都應對應**同一環境**；不要跨環境混用，也不要把 secret 寫入 Git。Local 的 `npm run start` 只接受 loopback Supabase URL／DB 與 Redis，並核對 migration 歷史；詳見[安裝與開發指南](development.md#正式本機安裝與啟動現行-local-only-路徑)。

## 設定與密鑰邊界

以 [`.env.example`](../.env.example)、`scripts/start-local.mjs`、[WebRTC 驗證文件](verification/webrtc-browser-deployment.md) 及部署平台的環境設定核對變數；範例檔包含歷史能力欄位，不表示每項都是現行錄製路徑必填。

| 類別 | 變數或設定 | 規則 |
| --- | --- | --- |
| Supabase 伺服器端 | `SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`SUPABASE_JWKS_URL` | 需屬同一環境；secret 只供後端。 |
| 瀏覽器安全值 | `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY` | 僅放可公開的 URL／publishable key；不得放 service key 或私鑰。 |
| 身分與來源 | `AUTH_ALLOWED_EMAIL_DOMAINS`、`APP_ORIGIN` | 設為該環境核准的網域與實際來源；保留 `/api/live-token` 的授權、速率及 Origin 保護。 |
| Viewer signaling | `WEBRTC_SIGNALING_REDIS_URL`、`WEBRTC_SIGNALING_REDIS_TOKEN`、`WEBRTC_ICE_SERVERS_JSON` | Vercel signaling 採 Redis HTTPS REST；ICE／TURN 資訊僅由伺服器端提供，跨網路連線需實機驗證。 |
| 背景工作與其他金鑰 | `CRON_SECRET`、必要的非 Live `GEMINI_API_KEY` | 僅在對應能力啟用時設定於伺服器端；Live token 使用錄製者的請求範圍 API key，不把長效 key 發至瀏覽器。 |

`SUPABASE_REALTIME_SIGNING_PRIVATE_JWK` 等保留於歷史／其他能力的設定不得被誤寫為 Viewer DataChannel 字幕的必要資料來源。不要在文件、CLI 輸出、截圖或 log 公開 access token、share code、private key、TURN credential 或 API key。

## Migration 與 Preview 部署

1. 在**已核對的 Local 或獨立 Preview 目標**檢視目前 migration 與相容性；本機資料庫初始化若需 `npm run db:reset`，只限可拋棄的空白 Local 資料，不能用於既有會議或長測。
2. 部署 migration 前，人工確認 Supabase CLI 目前連結的 project ref、名稱與目標環境。`npm run deploy:supabase` 執行 `supabase db push --linked`，會寫入**目前連結**的資料庫；腳本不替你切換專案，也不保證連結不是 Production。此處不提供可直接對 Production 執行的預設命令。
3. Preview 使用獨立的 Vercel 專案／環境設定。`npm run deploy:preview` 的腳本會執行 `vercel deploy --yes`，取得 Preview URL 後執行 deployment preflight；這是**部署與遠端檢查**，不是唯讀本機檢查。只有在核對專案連結與 Preview 變數後才使用。
4. 核對 Preview `/healthz`、`/readyz`、登入、Meeting metadata 授權及 Host／Viewer WebRTC；跨網路 TURN 與 RC1 實機項目仍須另行驗收。若 Supabase 契約或設定缺失，API 應失敗關閉，不能退回舊雲端錄音路徑。

`vercel.json` 指向 `npm run build` 的靜態輸出與 API Function 路由；`scripts/deploy-preview.sh` 和 `scripts/deploy-supabase-migrations.sh` 是上述部署行為的實際來源。Production 發布、migration 套用與流量切換需在確認 RC Gate、備份／相容性及目標專案後，依團隊既有核准流程另行執行；此文件不提供一鍵 Production 指令。

## 基本回退原則

若 Preview／Production 發現問題，先停止推進流量並保留原始證據；應用程式可回到前一個已驗證的部署版本。資料庫 migration 可能不可逆，不要在未評估資料相容性時執行降版或 reset；優先使用相容的前向修復。Host 本機內容仍由原瀏覽器與 30 分鐘保留期限管理，重新部署不會把內容搬到 Supabase，也不能替跨裝置 Viewer 還原錄音。事故觀察與檢查項目參見[測試文件](TESTING.md)及[觀測 Runbook](observability-runbook.md)。

## 授權

本專案有權授權的內容採用 [MIT License](../LICENSE)，`Copyright (c) 2026 Po-Chun Ruan`。Academia Sinica（中央研究院）僅為作者所屬機構，不是共同著作權人或官方背書。第三方套件、Gemini API 與其他服務各有自己的授權及使用條款，不因本專案採 MIT 而免費或取得額外權利。
