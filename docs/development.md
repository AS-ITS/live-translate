# 本機開發與環境變數

本機只使用本機 Supabase。根目錄 [`.env.example`](../.env.example) 是手動啟動 Dev Server 的 Sample；完整啟動不需要根目錄 `.env`。Google 登入見 [OAuth 教學](GOOGLE_OAUTH_SETUP.md)，雲端設定見 [部署指南](DEPLOYMENT.md)。

## 準備

需要 Node.js 22 以上、npm、Docker、Supabase CLI、`redis-cli`、`redis-server`，以及支援麥克風、Web Audio、OPFS／IndexedDB、WebRTC 的瀏覽器。先在專案根目錄執行 `npm ci`。依 [OAuth 教學](GOOGLE_OAUTH_SETUP.md#local-google-oauth)準備與 `supabase/config.toml` 的 Client ID 相配的 `supabase/.env.local`，並執行 `chmod 600 supabase/.env.local`。實際檔案已被 Git 忽略，Sample 不含 Secret。

## 方式 A：完整本機啟動

```bash
npm ci
npm run start -- --check
npm run start
```

`scripts/start-local.mjs` 會檢查或啟動 Local Supabase 與 loopback Redis，核對 Google OAuth Secret、API／DB URL、金鑰和 migration 版本，再同時啟動 API（預設 `127.0.0.1:3000`）與 Vite（預設 `127.0.0.1:5173`）。`--check` 可能啟動服務，不是純唯讀；migration 不符會停止，不會重設資料庫。啟動器從 Supabase CLI 取得本機 URL、anon／service-role key，設定前後端環境變數並隔離雲端設定；**不讀取根目錄 `.env`**。若需限制本機登入網域，先在啟動命令的 shell 明確 `export AUTH_ALLOWED_EMAIL_DOMAINS=as.edu.tw,gmail.com`；未 export 時不限制網域。Google Client Secret 仍須自行準備。首次建立可拋棄的空白本機資料庫可用 `npm run db:start`；`npm run db:reset` 會清除本機資料。

`npm run start` 會注入固定的前端 Origin `http://127.0.0.1:5173`，不會偵測 Vite 實際綁定的 Origin；本機若改用其他前端 Origin，手動啟動時須設定對應的 `dev_frontend_origin`。

正式 Meeting 的 Gemini key 由 Host 在介面輸入。啟動器刻意清空伺服器 `GEMINI_API_KEY`；已退役的獨立 Translation Worker 相關變數僅在下方盤點歷史用途。

## 方式 B：手動 Dev Server

1. 啟動 Docker，在專案根目錄執行 `npx supabase start`，再執行 `npx supabase status -o json`。只使用輸出的 loopback `API_URL`、`ANON_KEY`、`SERVICE_ROLE_KEY`；不要使用 Preview／Production Supabase URL 或 Secret。核對 `API_URL` 的 port 與 `supabase/config.toml` 的 `[api].port` 相同。
2. 在另一終端執行 `redis-server --bind 127.0.0.1 --port 6379`，以 `redis-cli -u redis://127.0.0.1:6379 PING` 確認回應 `PONG`。本機 signaling 使用 TCP `redis://`；Vercel 使用 HTTPS REST URL 與 token，不能把此本機 URL 貼到雲端。
3. 從 [Sample](../.env.example)建立根目錄 `.env`，填入上述本機值：`API_URL` → `SUPABASE_URL` 和 `VITE_SUPABASE_URL`；`SERVICE_ROLE_KEY` → `SUPABASE_SECRET_KEY`；`ANON_KEY` → `VITE_SUPABASE_PUBLISHABLE_KEY`。`SUPABASE_JWKS_URL` 設為 `<API_URL>/auth/v1/.well-known/jwks.json`。預設前端 Origin `http://127.0.0.1:5173` 不需設定 `APP_ORIGIN` 或 `dev_frontend_origin`；若手動改用其他前端 Origin，設定相符的 `dev_frontend_origin`。
4. API 終端執行 `node --env-file=.env "$(command -v npm)" run server`；它執行的 npm script 就是 `npm run server`（`node server/index.js`）。Node 不會因 npm script 自動讀 `.env`，且目前 Node 的 `NODE_OPTIONS` 不允許 `--env-file`。此寫法讓 npm 與其子行程繼承 `.env`；也可直接執行 `node --env-file=.env server/index.js`。已存在的 shell 變數優先於 `.env`，啟動前請避免殘留雲端 Supabase 值。
5. Vite 終端執行 `npm run dev`。Vite 自動載入根目錄 `.env` 的 `VITE_*`，並由 `vite.config.js` 的 `loadEnv` 讀 `dev_backend_origin`。若前端 Origin 不同於預設值，確認 `dev_frontend_origin` 與實際網址一致；前端向 `/api` 發請求時，Vite proxy 預設轉到 `http://127.0.0.1:3000`，只有後端目標不同時才需設定 `dev_backend_origin`。可在前端開啟後查 `http://127.0.0.1:5173/api/healthz` 是否由 API 回應。
6. 核對 Google OAuth：`supabase/config.toml` 的 Local Client ID 要對應 `supabase/.env.local` 的 Secret；Google Authorized redirect URI 是實際 `API_URL/auth/v1/callback`，Supabase URL Configuration 需允許目前前端 Origin。詳見 [OAuth 教學](GOOGLE_OAUTH_SETUP.md#local-google-oauth)。

手動方式不執行啟動器的 migration、OAuth 與 Redis 檢查；若遇登入或資料庫錯誤，先執行方式 A 的 `--check` 查原因。不要把 `SUPABASE_SECRET_KEY` 或 Google Secret 寫成 `VITE_*`。

`AUTH_ALLOWED_EMAIL_DOMAINS` 為選填。未設定時不限制 Google 帳號的電子郵件網域；設定後只允許指定網域登入。可在手動 Dev Server 的根目錄 `.env` 寫 `AUTH_ALLOWED_EMAIL_DOMAINS=as.edu.tw,gmail.com`；API 由上述 `--env-file` 載入。Google OAuth Audience／Testing 限制不受此變數影響。

## 環境變數盤點

以下「未設」描述目前程式行為；「條件」表示使用該功能才需要。位置是主要讀取處或注入處。Secret 欄「視內容」代表 TURN credential 等敏感值。自動項由啟動器或平台提供。

### Local Start 自動設定

| 變數 | 位置與用途 | 適用／必要性 | Secret | 未設時 |
| --- | --- | --- | --- | --- |
| `NODE_ENV`, `LOCAL_SUPABASE_MODE` | `start-local.mjs` → `server/index.js`、`vite.config.js`；選本機模式 | Local Start／自動 | 否 | 手動模式採一般 development 行為 |
| `SUPABASE_TELEMETRY_DISABLED` | `scripts/start-local.mjs` → Supabase CLI；關閉 CLI telemetry | Local Start／自動 | 否 | CLI 使用自己的預設設定 |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | 啟動器 → `server/compositionRoot.js`；雲端資料存取 | Local Start／自動 | URL 否，key 是 | 本機啟動器拒絕缺少 key；手動後端不能用 Supabase repository |
| `SUPABASE_JWKS_URL` | 啟動器 → `server/accessControl.js`；驗證 JWT | Local Start／自動 | 否 | Auth gate 未配置；Production 回 503 |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | 啟動器 → `src/lib/supabaseAuth.js`；瀏覽器登入 | Local Start／自動 | 否 | 前端 Supabase client 不可用 |
| `SUPABASE_PUBLISHABLE_KEY` | 啟動器 → `src/infrastructure/supabaseRestClient.js`；後端公開 REST fallback | Local Start／自動 | 否 | 優先使用 `VITE_SUPABASE_PUBLISHABLE_KEY`；兩者皆無則無公開 REST key |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | `scripts/start-local.mjs` → `server/accessControl.js`；限制登入網域 | Local Start／選填，僅保留 shell 明確設定值 | 否 | 不限制 Google 帳號的電子郵件網域 |
| `APP_ORIGIN`, `dev_frontend_origin` | 啟動器 → `server/index.js`；CORS／網站 Origin | Local Start／自動 | 否 | development 使用預設 `http://127.0.0.1:5173`；Production 缺 Origin 會限制請求 |
| `dev_backend_origin` | 啟動器 → `vite.config.js`；`/api` proxy | Local Start／自動 | 否 | proxy 指向 `http://127.0.0.1:3000` |
| `WEBRTC_SIGNALING_REDIS_URL`, `WEBRTC_SIGNALING_REDIS_TOKEN` | 啟動器 → `server/index.js`；本機 signaling TCP | Local Start／自動，token 留空 | URL 視內容，token 是 | signaling backend 無法連線 |
| `REDIS_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | `start-local.mjs`；清除／隔離繼承的雲端 Redis 設定 | Local Start／自動 | token 是 | 本輪主流程不直接讀這些值 |
| `GEMINI_API_KEY`, `ENABLE_REAL_GEMINI_TEST`, `LOCAL_MOCK_PROVIDER` | 啟動器 → `server/index.js`、`vite.config.js`；隔離真實 API／可選 mock | Local Start／自動；mock 可先由 shell 設 `true` | key 是 | key 被清空、real test=false、mock=false |
| `SUPABASE_REALTIME_SIGNING_PRIVATE_JWK`, `SUPABASE_WORKER_USER_ID` | 啟動器 → 舊 Realtime／Worker 路徑；清空雲端值 | Local Start／自動 | JWK 是 | 相關歷史／進階路徑不可用 |

### Dev Server 必要設定

| 變數 | 位置與用途 | 適用／必要性 | Secret | 未設時 |
| --- | --- | --- | --- | --- |
| `APP_ORIGIN`, `dev_frontend_origin` | `server/index.js`；網站 Origin／CORS | Dev Server／預設免填；非預設前端 Origin 設 `dev_frontend_origin`，`APP_ORIGIN` 選填 | 否 | 使用預設 `http://127.0.0.1:5173`；兩者皆設時，開發模式優先使用 `dev_frontend_origin` |
| `dev_backend_origin` | `vite.config.js`；API proxy | Dev Server／條件：API 非預設網址時必填 | 否 | proxy 到 `127.0.0.1:3000` |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL` | `server/compositionRoot.js`、`server/accessControl.js`；資料與 JWT | Dev Server／正式登入與 Meeting 必填 | URL 否；key 是 | 雲端 repository／Auth gate 不可用 |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | `src/lib/supabaseAuth.js`；瀏覽器 Auth | Dev Server／正式登入必填 | 否 | 前端 Supabase client 不可用 |
| `SUPABASE_PUBLISHABLE_KEY` | `src/infrastructure/supabaseRestClient.js`；後端 REST fallback | Dev Server／選填 | 否 | 使用 `VITE_SUPABASE_PUBLISHABLE_KEY`；兩者皆無則無公開 REST key |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | `server/accessControl.js`；email 白名單 | Dev Server／選填 | 否 | 不限制 Google 帳號的電子郵件網域 |
| `WEBRTC_SIGNALING_REDIS_URL`, `WEBRTC_SIGNALING_REDIS_TOKEN` | `server/index.js`；Viewer signaling | Dev Server／有 Viewer 時 URL 必填，TCP token 可空 | URL 視內容；token 是 | signaling 不可用 |
| `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET` | `supabase/config.toml`；Google provider | Dev Server／Google 登入必填，放 `supabase/.env.local` | 是 | Google provider 無法啟用 |

### Preview／Production 必要設定

| 變數 | 位置與用途 | 適用／必要性 | Secret | 未設時 |
| --- | --- | --- | --- | --- |
| `APP_ORIGIN` | `server/index.js`；正式網站 Origin／CORS | Preview、Production／必填 | 否 | Vercel 網址可能提供 fallback，但自訂網址與 token CORS 無保證 |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL` | `server/cloudEnvironment.js`、`server/accessControl.js`；資料與 JWT | Preview、Production／必填 | URL 否；key 是 | readiness 失敗／受保護 API 503 |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | `src/lib/supabaseAuth.js`；瀏覽器 Auth | Preview、Production／必填 | 否 | 無法登入；雲端檢查可能報錯 |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | `server/accessControl.js`；完整 email 網域白名單 | Preview、Production／選填 | 否 | 不限制 Google 帳號的電子郵件網域 |
| `WEBRTC_SIGNALING_REDIS_URL`, `WEBRTC_SIGNALING_REDIS_TOKEN` | `api/webrtc/[...path].js`；HTTPS REST signaling | Preview、Production／Viewer 必填 | URL 視供應商，token 是 | Viewer signaling 不可用 |
| `NODE_ENV`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_BRANCH_URL` | `server/index.js`；環境與 Preview Origin | Preview、Production／平台自動 | 否 | 缺平台資訊時僅依明確 `APP_ORIGIN`／`NODE_ENV` |

詳細部署清單與外部 OAuth 設定見 [部署指南](DEPLOYMENT.md)。

### 進階功能與歷史相容

| 變數 | 位置與用途 | 適用／必要性 | Secret | 未設時 |
| --- | --- | --- | --- | --- |
| `LOCAL_REDIS_URL`, `LOCAL_SUPABASE_WORKDIR` | `scripts/start-local.mjs`；本機 TCP／工作路徑覆寫 | Local Start／選填 | 否 | Redis `127.0.0.1:6379`、目前專案目錄 |
| `WEBRTC_ICE_SERVERS_JSON` | `server/index.js`、`api/webrtc/[...path].js`；STUN／TURN | Local、Preview、Production／網路需 TURN 時條件必填 | 視內容 | 使用程式預設 ICE；跨網路連線可能失敗 |
| `GEMINI_API_KEY` | `src/infrastructure/geminiEnvironment.js`、`server/compositionRoot.js`；舊獨立翻譯／重譯 provider | 歷史路徑／非目前安裝必需 | 是 | 舊 provider 無法建立；正式 Meeting 仍可由 Host 輸入 key |
| `TRANSLATION_PROVIDER` | `src/infrastructure/translationProviderConfiguration.js`；舊獨立翻譯 provider 選擇 | 歷史路徑／非目前安裝必需 | 否 | 預設 `gemini` |
| `LIVE_TRANSLATE_MODEL`, `LIVE_TRANSCRIPTION_MODEL` | `server/tokenService.js`；Live model | Local、Preview、Production／選填 | 否 | 使用程式預設模型 |
| `SAVED_RETRANSLATION_GEMINI_MODEL`, `SAVED_RETRANSLATION_TIMEOUT_MS` | `src/infrastructure/geminiSavedTranscriptTranslationComposition.js`；重譯模型／逾時 | 獨立重譯／選填 | 否 | 使用程式預設模型／逾時 |
| `TRANSCRIPT_POLISHING_MODEL`, `TRANSCRIPT_POLISHING_MAX_RPM` | `server/compositionRoot.js`；潤稿模型／速率 | 潤稿／選填 | 否 | 使用預設模型／15 RPM |
| `VITE_TRANSCRIPT_POLISHING_ENABLED`, `VITE_TRANSCRIPT_POLISHING_INTERVAL_MS`, `VITE_TRANSCRIPT_POLISHING_MIN_CHARS`, `VITE_TRANSCRIPT_POLISHING_MAX_RPM` | `src/features/workspace/WorkspaceComponents.jsx`；瀏覽器潤稿排程 | Local、Preview、Production／選填 | 否 | 啟用；30 秒、200 字、15 RPM |
| `LOCAL_MOCK_PROVIDER` | `vite.config.js`；本機 mock Gemini browser module | Local／測試條件 | 否 | 使用真實 browser module |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX` | `server/index.js`；API rate limit | 所有環境／選填 | 否 | 60 秒／20 次 |
| `LIVE_TRANSLATE_DIAGNOSTICS`, `LIVE_PIPELINE_TRACE_ENABLED` | `vite.config.js`、`server/publicRuntimeConfig.js`；診斷 | Local、隔離 Preview／選填 | 否 | 關閉 |
| `OBSERVABILITY_INSTANCE_ID` | `src/infrastructure/structuredLogger.js`；日誌 instance | 所有環境／選填 | 否 | `instance-<pid>` |
| `CRON_SECRET`, `WORKER_BATCH_SIZE` | `api/internal/worker.js`；舊 Worker API 授權／批次 | 歷史路徑／非目前安裝必需；舊 API 呼叫端仍須有 Secret | Secret 是；batch 否 | 無 Secret 回 401；batch 預設 3 |
| `SUPABASE_WORKER_USER_ID` | `src/infrastructure/supabaseGlossary.js` 等；舊 Worker ownership fallback | 歷史路徑／非目前安裝必需 | 否 | 無 request owner 時操作失敗 |
| `SESSION_SNAPSHOT_MAX_BYTES`, `TRANSLATION_OUTPUT_MAX_BYTES`, `MEETING_CHECKPOINT_MAX_BYTES`, `SESSION_AUDIO_MAX_BYTES` | `server/index.js`；payload 上限 | 所有環境／選填 | 否 | 預設 25、25、25、50 MiB |
| `DATA_DIR`, `SESSION_RECORDS_FILE`, `MEETING_RECORDS_FILE`, `SESSION_SHARES_FILE`, `RECORDER_LEASES_FILE`, `SESSION_AUDIO_DIR`, `TRANSLATION_GLOSSARY_FILE`, `TRANSLATION_DURABLE_QUEUE_FILE`, `TRANSLATION_DEAD_LETTER_QUEUE_FILE` | `server/compositionRoot.js` 與檔案 repository；儲存路徑覆寫 | 本機／選填；雲端勿依賴本機檔案持久性 | 否 | 使用各 repository 預設路徑 |
| `P1_PROFILE_ONLY` | `server/index.js`；舊 profile-only gate | 歷史相容／選填 | 否 | false |
| `VITE_MEETING_VIEWER_REALTIME_ENABLED`, `SUPABASE_REALTIME_SIGNING_PRIVATE_JWK` | `src/lib/meetingViewerRealtime.js`、`server/viewerRealtimeTokenService.js`；舊 Realtime viewer | 歷史相容／條件 | JWK 是 | 舊 viewer 關閉／無法簽 token |

### 測試專用與已退役設定

下列變數只供所列測試或工具使用，皆為條件式測試輸入；未設時該測試依 fixture 預設值執行、跳過，或由測試前置檢查拒絕執行。它們不是 Local／Preview／Production 安裝必填設定，也不放入主要 Sample。

| 變數 | 位置與用途 | Secret | 未設時／狀態 |
| --- | --- | --- | --- |
| `ENABLE_REAL_GEMINI_TEST`, `ISSUE41_TEST_GEMINI_KEY`, `LIVE_SMOKE_DURATION_MS`, `LIVE_SMOKE_MAX_TOKEN_REQUESTS`, `LIVE_SMOKE_REQUIRE_RECONNECT`, `LIVE_SMOKE_SPEECH_INTERVAL_MS`, `LIVE_SMOKE_SPEECH_TEXT`, `LIVE_SMOKE_TARGET_LANGUAGE`, `LIVE_SMOKE_TIMEOUT_MS` | `scripts/live-smoke-test.js`、`scripts/issue41-local-runner.mjs`；需明確 opt-in 的真實 API／smoke | test key 是；其餘否 | real API 不啟用；smoke 使用腳本預設值 |
| `SUPABASE_TEST_URL`, `SUPABASE_TEST_PUBLISHABLE_KEY`, `SUPABASE_TEST_SERVICE_ROLE_KEY`, `RUN_SUPABASE_RLS_TESTS`, `RUN_SUPABASE_LIFECYCLE_TESTS`, `RUN_SUPABASE_ROLE_TESTS`, `ALLOW_REMOTE_RLS_TESTS`, `API_URL`, `SERVICE_ROLE_KEY` | `tests/integration/`、`.github/workflows/supabase-migrations.yml`；隔離 Supabase 測試與 CLI 輸出 | service-role key 是；其餘否 | 對應測試跳過或前置檢查拒絕；不需 Production key |
| `CLOUD_BASE_URL`, `CLOUD_TEST_ACCESS_TOKEN`, `CLOUD_TEST_NON_OWNER_ACCESS_TOKEN`, `SMOKE_BASE_URL` | `tests/cloud/`、`scripts/deployment-preflight.js`；雲端 smoke | access token 是；URL 否 | 雲端 smoke 無目標或授權，不能執行 |
| `E2E_LOCAL_ACCESS_TOKEN`, `E2E_LOCAL_REFRESH_TOKEN`, `E2E_TEST_MODE`, `CI` | `tests/e2e/`、`server/index.js`；測試身分／環境 | access／refresh token 是；其餘否 | 測試使用 fixture 或不啟用對應模式 |
| `MOCK_GOOGLE_GENAI_AUTH_ERROR`, `MOCK_GOOGLE_GENAI_LIVE_ERROR`, `MOCK_GOOGLE_GENAI_TOKEN_NAME` | `tests/fixtures/mockGoogleGenAi.mjs`；注入 mock 錯誤／token 名稱 | 否 | mock 不注入錯誤、使用預設名稱 |
| `LOCAL_DEVICE_POC_ALLOWED_ORIGINS`, `LOCAL_DEVICE_POC_FAIL_POST_AFTER_PENDING_AT`, `LOCAL_DEVICE_POC_HOST`, `LOCAL_DEVICE_POC_PORT`, `LOCAL_DEVICE_POC_STATE_FILE`, `LOCAL_DEVICE_POC_TLS_CERT_FILE`, `LOCAL_DEVICE_POC_TLS_KEY_FILE` | `scripts/local-device-poc-service.js`；獨立 PoC 的網路／檔案設定 | TLS key 路徑敏感，其餘否 | 使用 PoC 預設值或不啟用 TLS／故障注入 |
| `ISSUE41_AUDIT_NAMESPACE`, `ISSUE41_AUTH_EXPIRY_SMOKE`, `ISSUE41_CORE_ACCEPTANCE`, `ISSUE41_E2E_API_PORT`, `ISSUE41_E2E_FRONTEND_PORT`, `ISSUE41_EVIDENCE_FILE`, `ISSUE41_FINAL_GATE`, `ISSUE41_FIXTURE_CLOCK_CONTRACT`, `ISSUE41_ISOLATED_DB_CONTAINER`, `ISSUE41_ISOLATED_PROJECT`, `ISSUE41_ISOLATED_SUPABASE_URL`, `ISSUE41_ISOLATED_URL`, `ISSUE41_LOCAL_AUDIO_WAV`, `ISSUE41_LOCAL_SMOKE`, `ISSUE41_PRE_DB_CONTAINER`, `ISSUE41_PRE_REST_CONTAINER`, `ISSUE41_PRE_STORAGE_CONTAINER`, `ISSUE41_PRE_SUPABASE_URL`, `ISSUE41_RAM10_DIAGNOSTIC`, `ISSUE41_RAM2_DIAGNOSTIC`, `ISSUE41_RAM_3C_PROFILE`, `ISSUE41_RAM_ABC_MODE`, `ISSUE41_RAM_ABC_SMOKE`, `ISSUE41_RAM_ATTRIBUTION_SMOKE`, `ISSUE41_REAL_GEMINI_AUDIO`, `ISSUE41_REAL_TIME_ROLLOVER`, `ISSUE41_RECORDING_ONLY`, `ISSUE41_RECORDING_SOAK_MINUTES`, `ISSUE41_REDIS_URL`, `ISSUE41_RESOURCE_FILE`, `ISSUE41_ROLLOVER_CONTRACT`, `ISSUE41_RUN_DIR`, `ISSUE41_SERVER_FETCH_AUDIT_FILE`, `ISSUE41_SHORT_VALIDATION`, `ISSUE41_SIGNALING_PORT`, `ISSUE41_SIGNALING_REQUEST_LOG`, `ISSUE41_SIGNALING_URL`, `ISSUE41_VIRTUAL_MIC_EVIDENCE_FILE`, `ISSUE41_ZERO_WRITE_AUDIT` | `tests/e2e/`、`tests/integration/`、`scripts/issue41-*.mjs`；RC1 隔離執行、port、證據與診斷 | 依內容，URL／證據路徑不應含 key | 對應測試使用 fixture 預設、跳過或前置檢查拒絕 |

已退役的 Cloud Recording、Cloud Cue、Meeting SSE **正式功能**設定不列入主要 Sample；舊 Realtime viewer 的兩個相容變數仍列在進階表，沒有刪除程式碼。測試命令和 real API 門檻見 [測試指南](TESTING.md)。
