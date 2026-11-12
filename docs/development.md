# Live Translate Development Guide

## 正式本機安裝與啟動（現行 Local-only 路徑）

本節供首次安裝者使用。下方既有 Phase 與雲端能力段落保留為開發／歷史脈絡；若描述 Supabase 保存錄音、Cue、Transcript 或 Viewer 從雲端重播，應以[現行架構](architecture/architecture-overview.md#現行正式產品架構local-only)為準。

### 系統需求

CI 使用 Node.js 22；長會議測試也涵蓋 Node.js 24。`package.json` 未宣告最低版本，建議先用 Node.js 22 與 npm。另需 Docker、Supabase CLI、`redis-cli`、`redis-server`、本機 Google OAuth client，以及支援麥克風、Web Audio、OPFS／IndexedDB、WebRTC 的瀏覽器。正式瀏覽器版本矩陣尚未完成 RC1 實機驗收。

### 安裝與環境變數

在本專案根目錄執行 `npm ci` 安裝 lockfile 指定的依賴。這會修改本機 `node_modules`；不是檢查命令。`supabase/config.toml` 設定本機 Google OAuth client ID；將自己的 client secret 以 `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET` 放入 Git 忽略的 `supabase/.env.local`，檔案需為一般檔案且權限為 `600`。不要把 secret、Supabase service key、Gemini API key 或短效 token 寫入 Git、前端 `VITE_` 變數或日誌。

正式本機啟動器 `scripts/start-local.mjs` 從 loopback Supabase 讀取 URL 與金鑰，為 API／Vite 設定 `SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`SUPABASE_JWKS_URL`、`VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`、`AUTH_ALLOWED_EMAIL_DOMAINS=as.edu.tw`、`WEBRTC_SIGNALING_REDIS_URL` 與 `APP_ORIGIN`。它不把根目錄 `.env` 當成本機必填設定；[`.env.example`](../.env.example) 主要供其他手動／部署環境核對。真實 Live 翻譯的 API key 由錄製者在介面提供，僅供該次請求換取短效 token；啟動器將伺服器端 `GEMINI_API_KEY` 設為空值，後者只供另行設定的非 Live 後端工作使用。

### 本機資料庫與啟動順序

| 階段 | 指令 | 作用與副作用 |
| --- | --- | --- |
| 安裝 | `npm ci` | 安裝依賴，修改 `node_modules`。 |
| 初次建立**可拋棄的空白本機**資料庫 | `npm run db:start`，必要時 `npm run db:reset` | 啟動 Local Supabase；`db:reset` 會重建本機資料，**不得對既有會議或長測資料執行**。 |
| 前置檢查 | `npm run start -- --check` | 驗證 Docker、Local Supabase、Google OAuth、migration、Redis；必要時會啟動 Local Supabase／Redis，**不是純唯讀**。migration 不一致時會阻止啟動，不會自動 reset。 |
| 正式本機啟動 | `npm run start` | 啟動 API（預設 `127.0.0.1:3000`）與 Vite（預設 `127.0.0.1:5173`）；`start:local` 是同一腳本。 |

僅在確認目標為**新建、沒有需保留資料的本機 Supabase** 時才考慮 `db:reset`。不要把 Local 的 Supabase URL 或金鑰指向 Preview／Production。開啟終端印出的 Vite URL；實際連接埠若被占用，以啟動輸出為準。`npm run dev` 與 `npm run server` 是分開啟動的開發腳本，不會替代正式本機啟動器的前置檢查。

### 常見問題

- **顯示 `Local startup blocked`：**檢查 Docker、Supabase CLI、Google OAuth secret 的檔案權限，以及本專案 migration 是否已套用；先閱讀錯誤訊息，不要直接 reset 既有資料。
- **Redis 無法連線：**本機腳本只接受 loopback `LOCAL_REDIS_URL`，需要 `redis-cli` 與 `redis-server`；若服務已在執行，先確認其實際連接埠。
- **無法登入或開始翻譯：**本機登入限目前授權網域及帳號規則；真實 Gemini Live 需要錄製者提供可用 API key。測試模式與真實 API 用量分開，參見[測試政策](TESTING.md)。
- **跨裝置 Viewer 無法連線：**WebRTC signaling 需要 Redis，跨網路可能需要可達 TURN；實機矩陣仍待驗收，參見[WebRTC 驗證文件](verification/webrtc-browser-deployment.md)。

## 舊版手動開發流程（非上方正式本機啟動流程）

下列章節保留舊版與其他能力的開發紀錄。舊文件中的「Supabase-only」僅可用於當時的伺服器資料路徑，不適用於現行 Host 錄製內容；`data/` JSON 檔為歷史測試資料。原有 `supabase start`、`supabase db reset`、`supabase db lint` 可用於隔離開發環境，但 `db reset` 會重建資料，不應當作一般啟動步驟。手動分開啟動時，後端需由環境提供 `SUPABASE_URL` 與 `SUPABASE_SECRET_KEY`；正式本機啟動器則自行從 Local Supabase 組出這些值。`/readyz` 可協助區分端點、migration 與憑證問題。不要提交或記錄 service key。

## Environment Variables

Backend environment variables:

- `GEMINI_API_KEY`: Server-only key for isolated non-Live Gemini workers (for
  example saved transcript translation). Live token issuance uses the
  recorder's request-scoped `geminiApiKey` instead.
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY`: server-only Supabase values.
- `SUPABASE_JWKS_URL`: Supabase public JWKS endpoint used to verify access tokens.
- `AUTH_ALLOWED_EMAIL_DOMAINS`: comma-separated Workspace email domains.
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`: browser-safe values.
- `P1_PROFILE_ONLY=true`: optional compatibility switch that keeps non-Profile
  cloud capabilities fail-closed. Leave unset for the current owner-scoped
  cloud runtime.
- `LIVE_PIPELINE_TRACE_ENABLED=true`: explicitly enables the browser-memory
  spoken-turn trace through `/api/runtime-config`. Set only on the Vercel
  Preview environment used for diagnosis; default and Production are `false`.
- Supabase P2 does not persist a user's Gemini API Key. The removed profile
  credential API and `gemini_credentials` store are not part of the current
  Live flow.
- `SAVED_RETRANSLATION_TIMEOUT_MS`: Optional timeout for saved transcript
  retranslation Gemini calls. Defaults to `30000`.
- `dev_frontend_origin`: Development frontend origin. Defaults to
  `http://127.0.0.1:5173`.
- `dev_backend_origin`: Development backend origin used by the Vite proxy.
  Defaults to `http://127.0.0.1:3000`.
- `DATA_DIR`: Optional directory for file-backed persistence. Defaults to
  `./data` outside production and `/var/data` in production.
- `SESSION_SNAPSHOT_MAX_BYTES`: Optional saved session snapshot JSON request
  limit. Defaults to `26214400`.
- `SESSION_AUDIO_MAX_BYTES`: Optional per-request WAV upload limit. Defaults to
  `52428800`.
- `SESSION_SHARES_FILE`: Optional override for persisted session share tokens.

The development server binds to `127.0.0.1:3000` and Vite binds to
`127.0.0.1:5173`. The production server binds to `0.0.0.0:8000` and accepts
the origin `http://127.0.0.1:8000`.

Development example:

```env
GEMINI_API_KEY=your_gemini_api_key
SAVED_RETRANSLATION_TIMEOUT_MS=30000
dev_frontend_origin=http://127.0.0.1:5173
dev_backend_origin=http://127.0.0.1:3000
DATA_DIR=./data
SESSION_SNAPSHOT_MAX_BYTES=26214400
SESSION_AUDIO_MAX_BYTES=52428800
```

## Preview transport diagnostic export

Set `LIVE_PIPELINE_TRACE_ENABLED=true` and restart or redeploy the Preview. No diagnostic UI button is shown. On both the Recorder and Viewer, open DevTools Console before reloading and run:

```js
const json = window.__liveTranslateDebug.exportPipelineTrace()
copy(json)
```

Save the copied values as separate Recorder and Viewer `.json` files from the same Meeting. Exporting only snapshots the in-memory trace and never stops recording or rebuilds WebRTC. The trace remains available after `recovery_failed` until the page reloads or `window.__liveTranslateDebug.clearPipelineTrace()` is called explicitly.

The exported document uses `schemaVersion: "live-pipeline-trace/v1"` and a bounded 20,000-entry ring buffer. Transport entries include the safe correlation fields `participantId`, `viewerId`, `transportGeneration`, `negotiationId`, signaling sequence/cursor metadata, participant TTL, message expiry, PeerConnection/ICE/DataChannel state, and scheduled recovery attempt state. `retryCounterSemantics: "incremented_when_scheduled"` documents that the current `retryAttempt` counter advances when a retry is scheduled; it is not evidence that the attempt has already failed. The fixed allowlist never includes transcript text, audio, credentials, SDP, ICE candidate bodies or IP addresses, share tokens/codes, JWTs, API keys, or raw HTTP payloads. Reloading clears the browser-memory trace; no diagnostic data is uploaded or persisted to cloud storage.

## Vercel and Supabase cloud capabilities

P0 keeps the local Node runtime unchanged and adds a cloud-only Function shell.
Vercel Functions do not use the local WebSocket broadcaster or file-backed
`data/` directory. Translation work is processed by the bounded Vercel Cron
worker at `/api/internal/worker`. They expose health/readiness checks and return
a structured `503` when a cloud dependency is unavailable.

Use the Supabase CLI migration workflow locally:

```bash
npm run db:start
npm run db:lint
```

Use the local stack as the staging-equivalent validation environment:

```bash
npm run db:start
npm run db:lint
npm run test:integration
npm run test:e2e
```

These checks use local Supabase and do not call the Gemini production API. They validate local migrations, RLS, and data flow, but cannot replace production Supabase deployment and connection checks. After starting the local backend, an optional read-only deployment preflight is:

```bash
SMOKE_BASE_URL=http://127.0.0.1:3000 npm run test:deployment-preflight
```

Vercel environment variables are configured per environment in the Vercel
project. Keep `SUPABASE_SECRET_KEY` and future `KEY_ENCRYPTION_SECRET`
server-only; never prefix them with `VITE_`. The 4.5 MB Vercel Function
request/response limit means the current large snapshot, checkpoint, and audio
routes remain disabled in the P0 cloud shell.

Secrets must be kept out of git. Use `.env` locally and keep `.env.example` as a
non-secret template.

Supabase mode requires a valid JWT, the `authenticated` role, and an email in
`AUTH_ALLOWED_EMAIL_DOMAINS`. Supabase access tokens are required for all
authenticated flows. P1 owner-scoped adapters support these cloud capabilities:

| Capability | Persistence / boundary |
| --- | --- |
| Meetings, Segments, Sessions, finalized Cues | Supabase repositories under owner-scoped RLS |
| Shares, recorder leases, audio metadata | Supabase repositories and private Storage metadata |
| Glossary, translation queue, DLQ, execution status | Supabase repositories and atomic queue RPCs |
| Meeting Viewer events | `meeting_events` persistence with cursor replay and Realtime delivery |
| Observability | Service-role metric RPCs and UTC-minute buckets |

If the required Supabase configuration is missing, or `/readyz` cannot verify
the core tables, metric/queue RPCs, or private `meeting-audio` Storage bucket,
these cloud APIs remain fail-closed with structured `503` responses.

## Cloud rollout preflight

When `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `SUPABASE_JWKS_URL` are
configured, new cloud writes use the owner-scoped Supabase repositories listed
above. Existing file-backed records are not migrated automatically. Before
production traffic, apply all migrations through
`20260914000000_observability_metric_buckets.sql`, run `npm run db:lint`, and
verify `/healthz` and `/readyz`. Readiness must confirm the observability table
and atomic metric RPC. The worker cron must use `Authorization: Bearer
$CRON_SECRET`; metric persistence is best-effort and must not change queue
processing outcomes.

Production smoke checks and alert thresholds are maintained in
[`docs/observability-runbook.md`](observability-runbook.md). Production
verification is a rollout task, not an unimplemented P1 capability.

The cloud rollout preflight must apply all migrations through the current migration head, run `npm run db:lint`, and verify `/healthz` plus `/readyz`. Readiness probes the core persistence tables, metric/queue RPCs, and private `meeting-audio` Storage bucket. In production, an invalid server-side cloud contract rejects `/api/*` with `503 cloud_capability_unavailable` so file-backed fallback cannot receive production traffic.

## Domain auto-activation behavior

`AUTH_ALLOWED_EMAIL_DOMAINS` is enforced by the backend after Supabase JWT verification. A matching Google Workspace user is provisioned as a transient pending `member`, then the service-role-only activation RPC changes only `pending -> active` before private API dispatch. Existing pending users follow the same path on their next valid request. Disabled users remain disabled, and missing or failed profile activation returns `503` without an active fallback.

## Local Development Setup

1. Install dependencies only when needed for local development.
2. Create a local `.env` file based on `.env.example`.
3. Start the backend server.
4. Start the frontend development server.
5. Open the frontend in a browser that supports the required Web Audio APIs.

When the Vite dev server is running, enter `o` followed by Enter in the same
terminal to open the actual Vite URL in the default browser. If the terminal
does not provide interactive keyboard input, or the operating-system browser
launcher is unavailable, use the URL printed by Vite manually. When port 5173
is already occupied, use the replacement port shown in that output.

Do not use real Gemini API calls for automated tests. Use real API calls only for
manual smoke testing with explicit approval.

## Development Milestones

1. Backend token endpoint
   - Implement `POST /api/live-token`.
   - Validate language and token options.
   - Create Gemini ephemeral tokens with server-side credentials.
   - Add unit tests with a mocked Gemini client.

2. Audio helpers
   - Convert float samples to PCM16 little-endian bytes.
   - Resample microphone audio to 16kHz.
   - Convert bytes to and from base64 when required by SDK payloads.
   - Add deterministic unit tests.

3. Frontend session lifecycle
   - Add explicit frontend states.
   - Request microphone permission.
   - Request ephemeral token.
   - Open and close Gemini Live sessions.

4. Live audio streaming
   - Capture microphone samples.
   - Chunk input audio into roughly 100ms frames.
   - Send chunks to Gemini.
   - Stop streaming cleanly when the session ends.

5. Output handling
   - Play translated audio.
   - Display input transcripts.
   - Display output transcripts.
   - Handle session errors and expected session end.

6. Manual smoke validation
   - Run local frontend and backend.
   - Use a real API key only after explicit approval.
   - Confirm the complete start, translate, playback, transcript, and stop flow.

## Manual Smoke Test Steps

Manual smoke testing requires explicit approval because it uses a real Gemini API
key.

Steps:

1. Start the backend; supply the recorder's request-scoped Gemini key through
   the UI. Configure `GEMINI_API_KEY` only when exercising an isolated
   non-Live worker.
2. Start the frontend development server.
3. Open the app in the browser.
4. Select `zh-Hant`.
5. Start a session.
6. Grant microphone permission.
7. Speak English.
8. Confirm translated audio plays.
9. Confirm source transcript updates.
10. Confirm translated transcript updates.
11. Stop the session.
12. Confirm microphone tracks close.
13. Confirm the UI returns to a non-listening state.

## Testing Scope

Backend unit tests:

- Valid token request.
- Invalid language.
- Default `echoTargetLanguage`.
- Gemini token creation failure.

Audio helper unit tests:

- Float audio converts to little-endian PCM16.
- Resampling produces deterministic output length.
- Base64 PCM conversion round-trips.

Frontend testing scope for MVP:

- Prefer focused unit tests for pure helpers.
- Prefer manual smoke testing for real microphone and Live API behavior.
- Avoid real API usage in automated tests.
- Avoid full benchmark or calibration runs unless the task specifically requests
  them.

## Coding Guidelines

- Keep the backend token service small and stateless.
- Keep Gemini API keys and long-lived credentials server-side only.
- Keep frontend session states explicit.
- Clean up microphone tracks, audio nodes, and Gemini sessions on stop or error.
- Keep SDK-specific event parsing isolated enough to update when Gemini payloads
  change.
- Prefer deterministic helper tests over browser or real API integration tests
  for MVP development.
- Mark uncertain provider fields with TODOs until verified against official SDK
  documentation.

## Out of Scope for v1

- User accounts.
- Persistent transcript storage.
- Room sharing or multi-user calls.
- Text input translation.
- Backend audio proxying.
- Server-side recording.
- Production analytics dashboards.
- Automated real Gemini API integration tests.
- Full benchmark runs.
- Dataset generation or benchmark report regeneration.

## Runtime capability matrix

現行正式 Meeting 的錄製內容一律為 Host Local-only。下表只列目前產品路徑；下方舊 worker／file-backed／Cloud Recording 說明屬歷史或其他能力，不可視為 Meeting 雲端錄製承諾。

| Capability | Local | Preview／Production |
| --- | --- | --- |
| Meeting 錄製內容 | Host OPFS／IndexedDB 保存 PCM、音訊、Cue、Transcript、Checkpoint、Journal、Recovery | 同為 Host OPFS／IndexedDB；換裝置或清除網站資料無法依賴 Supabase 還原 |
| Meeting metadata／設定／字典／授權 | 本機 Supabase，透過受權 API | 各環境獨立 Supabase，透過受權 API；僅保存必要協調 metadata |
| Viewer 字幕 | WebRTC DataChannel，Redis signaling | WebRTC DataChannel，Redis signaling；跨網路 TURN 需實機驗收 |
| Readiness | `/readyz` 檢查本機設定 | `/readyz` 檢查 Supabase 等部署設定，不代表 RC1 實機驗收通過 |

歷史 Cloud Recording、SSE／WebSocket Viewer adapter、Supabase Realtime 與 signed Storage URL 設計保留作遷移背景；它們不是現行正式 Meeting 的字幕或錄製內容交付能力。下文提及的雲端音訊、Cue、Transcript、Checkpoint 或 export worker 若未註明，均應依本段界定為歷史／其他能力，不可用來推定 Local-only Meeting 會上傳內容。

For the safe deployment preflight, set `SMOKE_BASE_URL` and run `npm run test:deployment-preflight`. It verifies `/healthz`, `/readyz`, unauthenticated private API rejection, metrics auth rejection, and worker auth rejection without calling Gemini or processing queue items. For the full staging smoke check, separately verify a valid owner-scoped API request and one authenticated worker request with `Authorization: Bearer $CRON_SECRET`. A successful `/healthz` response alone does not prove that Supabase migrations, RLS, or the worker are ready; legacy Storage／Realtime readiness checks, where still present, do not make those services the current Meeting content path.
## Production Gemini Smoke Test

For the first Production Gemini smoke test, keep the request short and avoid
the default long-meeting soak:

```bash
LIVE_SMOKE_DURATION_MS=60000 \
LIVE_SMOKE_SPEECH_INTERVAL_MS=10000 \
LIVE_SMOKE_REQUIRE_RECONNECT=false \
npm run test:live-smoke
```

Run this once only after confirming the Production `GEMINI_API_KEY` is
available to the smoke runner. Do not place that key in browser-exposed
`VITE_` variables or commit it.
### OAuth Workspace access

Google OAuth can complete successfully while `GET /api/profile` rejects a personal-domain or disabled account with `403 auth_forbidden`. `AUTH_ALLOWED_EMAIL_DOMAINS` remains the backend authority; Google `hd` hints are optional UI guidance only and are not an authorization control. The access-denied screen keeps the session long enough to show the current email, and users must choose “切換 Google 帳號” to sign out and reopen the Google account picker with `prompt=select_account`.
## Supabase request boundaries

本節以下的 P7／P8 Cloud Recording、signed Storage URL、雲端音訊清理及 legacy Session export 敘述是歷史／其他能力紀錄；不可作為 Issue #41 正式 Meeting 錄製內容或 Viewer 字幕來源的現行能力說明。現行資料邊界以[架構總覽](architecture/architecture-overview.md#現行正式產品架構local-only)與上方 capability matrix 為準。

Private owner CRUD may use the authenticated Supabase access token through the user-scoped REST client. Worker, admin, Vault, readiness, and other explicitly privileged operations use the service-role client. The two clients must not be interchangeable.

`/readyz` validates the server Supabase variables and confirms that `SUPABASE_URL`, `SUPABASE_JWKS_URL`, and `VITE_SUPABASE_URL` resolve to the same project without exposing configuration values. Missing or mismatched configuration remains fail-closed.
P7 cloud Meeting exports use `export_artifacts` metadata, the private
`meeting-exports` Storage bucket, and the existing PGMQ worker pattern through
the `export_jobs` queue. Readiness checks the bucket; missing cloud export
dependencies fail closed with `503`.

P8 makes transcript export cloud-only. Supabase deployments use the P7
asynchronous export panel and signed download URLs. Local file-backed mode
keeps meeting and transcript reads available but shows an export-unavailable
message; it does not generate browser transcript files and does not migrate
local JSON or audio data.

Issue #37's Cron retention-cleanup design is historical. Current Local-only
Meeting expiry does not run a worker; physical deletion uses the authorized
Meeting deletion service.

Phase 4 also exposes `purgeAt` in owner Meeting detail responses, returns
`410 meeting_content_expired` after the deadline but before physical deletion,
and records purge counts/latency under the `retention` metrics operation.
Lifecycle v2 repository writes leave legacy linkage/transcript columns empty or
null; v1 rows remain readable.
