# Testing

Issue #41 未解決回歸驗證缺口：mobile WebKit E2E 因找不到「繼續」按鈕而失敗；該流程尚未通過，不能計為 PASS。

Issue #41 音訊診斷面板與 OPFS 步驟標記已移除。iPhone Safari 私密瀏覽可能在本機音訊保存時回報 `UnknownError`，一般瀏覽模式已正常；請使用一般瀏覽模式保存會議音訊，並在匯出前確認音訊可用。翻譯音訊寫入失敗或缺段時不得提供不完整匯出；`tests/e2e/issue41TranslatedOpfsRca.spec.js` 保留正常 OPFS 寫入與 Reload 回讀回歸，WebKit 若無法取得 OPFS 根目錄會明確 skip，不能視為 iPhone 實機通過。

Issue #41 Pause → Reload → Continue 定向驗證：`tests/e2e/liveTranslate.spec.js` 的
`Local Pause Reload Continue commits both subtitle segments across second Pause and Reload`
會核對兩段 Cue、Transcript 與各段 Checkpoint cursor。`tests/unit/cueB2PendingIndexedDb.test.js`
另外驗證歷史 Pending Cue 在 Reload 後不能提交到新 Segment，原始歸屬與失敗診斷仍留在 IndexedDB。

Issue #41 登記前 Cue queue 失敗定向驗證：`tests/unit/issue41PreCoordinatorCueQueue.test.js`
確認未登記的失敗會保留待重試、阻擋 Pause／End，恢復後只提交一次；
`tests/e2e/liveTranslate.spec.js` 的 `pre-writer Cue setup failure retries before later Cue and Pause readback`
在 Chromium／mobile WebKit 注入首次 IndexedDB Segment 讀取失敗，核對安全診斷、兩個 Cue 的保存順序、Pause 與 Reload 回讀。
此測試使用模擬失敗，尚未取得 Safari 實機首次保存的原始 exception。

For current Issue #41 Local acceptance, use only this repository and run
`npm run start -- --check`, then `npm run start`. The launcher checks the
repository's Local Supabase migrations, Google Provider, and loopback Redis.
Keep the existing test Google OAuth client secret in `supabase/.env.local` as
`SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET` (mode 600, ignored by Git).
The Local launcher passes it to Supabase CLI on startup; do not put it in a
production `.env` file.
The isolated fallback procedure below is historical and is not the current
Local acceptance path.

## Issue #41 RC manual acceptance fallback (RC-M1 to RC-M6)

**Current decision:** `RC_MANUAL_FALLBACK_VERDICT=READY_NOT_EXECUTED`; the previous `RC1_VERDICT=BLOCKED` remains. An unstable isolated Supabase Realtime container is `ENV_BLOCKED`, never `PASS`. Do not use this fallback to waive DB/RPC/Storage, ownership, share authorization, or security contracts. Stop after two unsuccessful minimal repairs of the same environment fault.

### Issue #41 RC1 acceptance status (2026-11-09)

Audit modes: `--zero-write-audit` retains five-channel coverage, metadata allowlist, Database/RPC/Storage negative controls, coverage matrix, and Cloud Zero archive. `--ram-gate-40` and `--ram-gate-130` retain normal-flow Cloud Content Write monitoring across browser requests, server fetches, database triggers, and before/after inventories without running those negative controls. RAM archives include `server-fetch-audit.ndjson`; a RAM-mode monitoring result does not certify the separate Cloud Zero audit.

P1 End／Pause 競態定向 Chromium E2E：End 後立即返回、Pause 後立即 End、End 快速連點、Pause checkpoint 故障注入皆通過；回讀 Local-only Recording、OPFS PCM Journal、Cue、Checkpoint 與完成 API 次數。原有停止錄音→繼續→End、End 後禁錄、Cue flush 失敗回讀短版測試通過。`stopping` 故障恢復定向驗證：Checkpoint barrier 失敗不導頁、不完成 Meeting；重載後再次注入失敗時不啟動 Provider、不建立後繼 Segment；移除故障後經本機 Cue／Checkpoint 與 Journal receipt 驗證，可繼續錄音、再暫停並正常 End。這只解除 Lifecycle 已知阻擋；RC-M1／RC-M3 實機驗收及既有 RAM Gate 阻擋仍須依各自驗收完成。

Host Local-only 生命週期的定向驗證須以實際本機資料回讀為準：**開始錄製 → 停止錄音 → 繼續 → 停止錄音 → 繼續**。UI「停止錄音」是可恢復的暫停；兩次繼續沿用同一 Recording ID、建立後繼 Segment，暫停期間 PCM 不再收集。檢查 Cue、Checkpoint、PCM Journal／OPFS ownership 與重新載入回讀；錄製中正常導頁須先完成暫停 barrier，失敗時留在錄製頁；End 後不得再次錄製。刷新與強制關閉仍由既有 recovery 處理，不列入正常導頁通過證據。

定向短版 Local-only 稽核 `2026-11-09t03-17-00-566z-55420`：`node scripts/issue41-local-runner.mjs start --zero-write-audit` 為 `PASS`；重複暫停／繼續、正常 UI 導頁恢復、End 禁錄、OPFS／IndexedDB ownership 與 End 後回讀均由 E2E 驗證，`ownershipGate=PASS`、`cloudZeroWrite=PASS`。這不替代 130 分鐘 RAM Gate 或 RC-M1～RC-M6 實機驗收。

Run `2026-11-08t15-51-28-836z-27302` remains unchanged: 40-minute recording `PASS`; Cloud Zero Write `PASS`; evidence checks 11/11 `PASS`; RAM Gate and top-level evidence verdict `FAIL`. The failing provisional RAM checks are last-30-minute RSS/Heap slopes and 60-second RSS residual. CDP baseline and End +0/+30/+60-second snapshots contain backing storage, embedder heap, DOM, and Worker target counts. `RAM_OWNER_VERDICT=UNDETERMINED`: the snapshots do not establish a product-owned leak. `RC1_RELEASE_VERDICT=BLOCKED`. The previous 40-minute Gate recorded the same declared observer settings but no CDP snapshots; do not attribute cross-run RAM differences to product regression or change either run's evidence.

`RC1_FUNCTION_GATE_STATUS=PARTIAL`: targeted Local evidence covers member Meeting creation, owner/member isolation, Viewer metadata authorization, mock Viewer reconnection, and the 40-minute Local-only PCM/Journal/Cue/Checkpoint, Cloud Zero Write, End/Reload contract. An ordinary member browser flow, second-device Viewer network loss/reconnect, real-microphone Local-only integrity, and an RC1 Chrome/Safari device matrix remain unverified. The RC-M1 through RC-M6 full manual cases below remain `NOT_TESTED`; reuse passed automated evidence without rerunning those Gates.

Latest 130-minute run `2026-11-09t04-29-36-305z-60018`: `RECORDING_130MIN_VERDICT=PASS` (`7,800,033 ms`); 8/8 rollovers and 9 Segments completed and ended with ownership verified. PCM／Journal／Cue／Checkpoint integrity is `PASS`: 9 Journal epochs have zero gaps and overlaps and valid ledger／PCM hashes; End and Reload readback retained 7,646 audio chunks, 9 Cues, and 9 Checkpoints in `stopped_local`. `CLOUD_ZERO_WRITE_VERDICT=PASS` (0 DB violations, 0 recording HTTP write violations; 7,783 allowed metadata writes). `EVIDENCE_AUDIT_VERDICT=PASS` (11/11 checks). The runner's top-level `EVIDENCE_VERDICT=FAIL` reflects the RAM Gate failure, not a failed evidence check. `RAM_GATE_VERDICT=FAIL`: last-30-minute RSS slope 1.999 MiB/min exceeds the provisional 0.5 MiB/min limit; the other five RAM checks pass. `RC1_RELEASE_VERDICT=BLOCKED`. Source: [`summary.json`](../test-results/issue41-runner/2026-11-09t04-29-36-305z-60018/summary.json), [`evidence.json`](../test-results/issue41-runner/2026-11-09t04-29-36-305z-60018/evidence.json), and [`resources.ndjson`](../test-results/issue41-runner/2026-11-09t04-29-36-305z-60018/resources.ndjson).

RAM attribution for this run remains `UNDETERMINED`: renderer PID 60244 stayed stable, the 30-minute Gate window has 61 complete samples (largest gap 30.011 seconds), and End +0/+30/+60-second samples are present. Logs and browser errors show no OOM or browser crash. CDP backing storage, embedder heap, DOM, and Worker snapshots show no clear sustained growth; no heap snapshot was captured. The preceding 130-minute run `2026-11-09t00-54-35-131z-38411` is documented with RSS slope 0.850 MiB/min, but its raw report and observer configuration are absent from this worktree. `RAM_CROSS_RUN_COMPARABILITY=NOT_ESTABLISHED`; neither value proves product improvement or regression. Do not change the RAM threshold or infer a memory owner from these snapshots.

`130MIN_READINESS_VERDICT=SUPERSEDED_BY_RUN`: `node scripts/issue41-local-runner.mjs start --ram-gate-130` selects 130 real-time minutes, eight 15-minute rollovers, a 138-minute test timeout, 30-second RSS/Heap sampling with peak safety stops, periodic Local scans, Cloud Zero Write audit, and End/Reload checks. A failed test process leaves `runner.log`, `resources.ndjson`, partial `evidence.json`, Playwright output, and a final summary. Capture failures now retain a DB write-audit read and cloud inventory when available. Renderer crash or browser disconnect records `runtimeTermination` in evidence; it detects abnormal termination, but does not prove OOM. A killed runner process may leave no final summary, so preserved logs and samples remain the diagnostic source. Run `2026-11-09t00-54-35-131z-38411` 已完成；以下為當時執行器設定與診斷檔說明。

`RAM_RISK_ACCEPTANCE_OPTIONS`: keep RC1 blocked until a comparable RAM Gate passes; or request explicit, time-bounded acceptance of the measured RAM failure with an owner and rollback plan. A 130-minute functional `PASS` does not replace RAM Gate `PASS`, and no RAM threshold changes are authorized here.

Next necessary functional test: run `npm run start -- --check`, then `npm run start` in this repository. Use an ordinary member account to create a Meeting and exercise Host and second-device Viewer join, network disconnect/reconnect, 停止錄音／繼續, and 結束會議 under RC-M1/RC-M3; record browser/version, device, Meeting ID, cue replay, and authorization result in the existing RC report.

### RC1 驗收矩陣（依既有證據，截至 2026-11-09）

本矩陣以最新 130 分鐘報告 `2026-11-09t04-29-36-305z-60018` 為正式長測基線；40 分鐘及前次 130 分鐘報告保留為歷史證據。功能通過不等於 RAM Gate 或實機驗收通過。

| Gate／項目 | 現有判定 | 尚需確認 |
| --- | --- | --- |
| 40 分鐘 Local-only 錄製 | `PASS` | 僅代表該次錄製證據，不替代 RAM 或跨裝置 Gate。 |
| 最新 130 分鐘錄製與資料 | `PASS` | 8/8 rollover、9 個 Segment 均結束；PCM／Journal／Cue／Checkpoint、End／Reload 回讀通過。 |
| Cloud Zero Write | `PASS` | DB／錄製 HTTP 違規各 0；雲端仍可保存設定、字典與授權 metadata。 |
| Evidence Checks | `11/11 PASS` | 逐項檢查全過；runner 總體 `EVIDENCE_VERDICT=FAIL` 由 RAM Gate 導致。 |
| RAM Gate | `FAIL` | RSS 最後 30 分鐘斜率 1.999 MiB/min，大於 0.5；其餘 5 項 PASS，持有者未確定。 |
| RC-M1～RC-M6 實機流程 | `NOT_TESTED` | 一般 member、真實麥克風、Host／第二裝置 Viewer、斷線重連、End 與 30 分鐘清理。 |
| Chrome／Safari 實機矩陣 | `NOT_TESTED` | 瀏覽器版本、裝置、WebRTC／TURN 與匯出行為需實測。 |

總判定維持 `RC1_RELEASE_VERDICT=BLOCKED`、`RC1_FUNCTION_GATE_STATUS=PARTIAL`；不可將自動化證據推論為完整實機驗收。手動個案條件見下方「Manual cases pass criteria」，WebRTC 跨網路條件見[驗證 Runbook](verification/webrtc-browser-deployment.md)。

### Dependency boundary


The current Host records in the browser through `useLiveRecordingController`, `localMeetingPersistence`, MediaRecorder, and the PCM Journal. Its metadata and authorization use the authenticated Node API and Supabase PostgREST/RPC, not a Supabase Realtime subscription. The production Viewer page constructs `createWebRtcSubtitleTransport`; its signaling client calls `/api/webrtc/:meetingId`, and the Node handler stores signaling in Redis. The glossary client calls `/api/glossary` over HTTP. Meeting metadata, permissions, and share resolution use HTTP and Supabase database reads. None of these call paths subscribe to Supabase Realtime. `src/lib/meetingViewerRealtime.js` and `src/lib/executionEventsWebSocket.js` still contain older Supabase Realtime subscriptions, but the current Viewer page does not import them. This is a targeted call-path finding, not a complete Legacy inventory. Redis signaling and ordinary Supabase Auth/PostgREST remain necessary.

### Start isolated services and log in

Run from the repository root. Docker, Supabase CLI, Redis CLI/server, and npm must be installed. The workdir and DB project ID are unique; no command below targets Production. The manual test uses the existing `start:local` script, which starts API `127.0.0.1:3000` (including WebRTC signaling) and Vite `127.0.0.1:5173` together. Do not start a separate signaling service on port 3001; that port belongs to the E2E harness.

Terminal 1, create and start the isolated Supabase stack:

```bash
cd /Users/pochun/projects/live-translate
export RC_WORKDIR="$(mktemp -d /tmp/issue41-manual-XXXXXX)"
mkdir -p "$RC_WORKDIR/supabase"
cp -R supabase/migrations "$RC_WORKDIR/supabase/migrations"
node --input-type=module - "$RC_WORKDIR" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const workdir = process.argv[2];
const path = join(workdir, 'supabase/config.toml');
let config = readFileSync('supabase/config.toml', 'utf8');
const projectId = `issue41-manual-${Date.now()}`;
config = config.replace(/^project_id\s*=.*$/m, `project_id = "${projectId}"`)
  .replace(/\[api\]\nenabled = true/, '[api]\nenabled = true\nport = 55421')
  .replace(/\[db\]\nport = \d+/, '[db]\nport = 55422')
  .replace(/\[studio\]\nport = \d+/, '[studio]\nport = 55423')
  .replace(/\[auth.external.google\]\nenabled = true/, '[auth.external.google]\nenabled = false');
config += '\n[local_smtp]\nport = 55424\n[db.pooler]\nport = 55427\n[analytics]\nport = 55428\n';
writeFileSync(path, config);
console.log(`RC_WORKDIR=${workdir}\nRC_DB_CONTAINER=supabase_db_${projectId}`);
NODE
supabase start --workdir "$RC_WORKDIR" --yes
```

Record the printed `RC_WORKDIR` and `RC_DB_CONTAINER` (identifiers only). Supabase CLI may print local keys; do not paste its output into reports. If the stack fails or Realtime restarts repeatedly, keep the actual status `ENV_BLOCKED`. Non-Realtime unit and mock E2E work can continue, but manual DB-backed cases need Auth/PostgREST to stay healthy.

Terminal 2, start a loopback Redis dedicated to this run:

```bash
redis-server --bind 127.0.0.1 --port 16379 --save '' --appendonly no --protected-mode yes
```

Terminal 3, check and start the existing local launcher (replace the workdir):

```bash
cd /Users/pochun/projects/live-translate
export RC_WORKDIR=/tmp/issue41-manual-REPLACE_ME
LOCAL_SUPABASE_WORKDIR="$RC_WORKDIR" LOCAL_REDIS_URL=redis://127.0.0.1:16379 npm run start:local -- --check
LOCAL_SUPABASE_WORKDIR="$RC_WORKDIR" LOCAL_REDIS_URL=redis://127.0.0.1:16379 npm run start:local
```

The check validates loopback Supabase URL/DB ports, copied and applied migrations, local keys, Redis `PING`, and configured `AUTH_ALLOWED_EMAIL_DOMAINS`. `start:local` overrides cloud Supabase values in `.env*`, clears the backend Gemini key, and does not call Gemini. A real microphone/translation run requires a tester-owned Gemini key entered in the Host Settings UI; this is an explicitly manual, potentially billed API call. Do not put that key in the report or browser console. Confirm `redis-cli -h 127.0.0.1 -p 16379 PING` returns `PONG`, API health via `curl -fsS http://127.0.0.1:3000/healthz`, and Vite at `http://127.0.0.1:5173`.

Create a local test user in isolated Auth. The first locally configured allowed email domain is selected; the password is read without echo and never printed:

```bash
export RC_WORKDIR=/tmp/issue41-manual-REPLACE_ME
RC_DOMAIN="$(node --input-type=module -e "import { loadEnv } from 'vite'; process.stdout.write((loadEnv('development', process.cwd(), '').AUTH_ALLOWED_EMAIL_DOMAINS || '').split(',')[0].trim())")"
test -n "$RC_DOMAIN" || { echo 'Missing local allowed email domain'; exit 1; }
export RC_EMAIL="issue41-manual-$(date +%s)@$RC_DOMAIN"
read -s 'RC_PASSWORD?Local test password: '; echo
export RC_PASSWORD
node --input-type=module - <<'NODE'
import { spawnSync } from 'node:child_process';
const result = spawnSync('supabase', ['status', '-o', 'json', '--workdir', process.env.RC_WORKDIR], { encoding: 'utf8' });
if (result.status !== 0) throw new Error('Isolated Supabase status failed');
const local = JSON.parse(result.stdout);
if (local.API_URL !== 'http://127.0.0.1:55421') throw new Error('Not the isolated loopback stack');
const response = await fetch(`${local.API_URL}/auth/v1/admin/users`, {
  method: 'POST',
  headers: { apikey: local.SERVICE_ROLE_KEY, Authorization: `Bearer ${local.SERVICE_ROLE_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.RC_EMAIL, password: process.env.RC_PASSWORD, email_confirm: true })
});
if (!response.ok) throw new Error(`Local Auth user creation failed: ${response.status}`);
console.log('Isolated Auth user created; sign in through the browser console.');
NODE
unset RC_PASSWORD
```

Open `http://127.0.0.1:5173` on Host. The normal login UI offers Google OAuth only, so use this **local test-account login** in that page's DevTools console (type the same local password into the prompt):

```js
const { supabase } = await import('/src/lib/supabaseAuth.js');
const result = await supabase.auth.signInWithPassword({ email: prompt('Local test email'), password: prompt('Local test password') });
if (result.error) throw result.error;
location.reload();
```

Use the Host UI to create a Meeting, then copy its Viewer share URL. On a second laptop, an SSH tunnel to the Host machine preserves the loopback addresses used by Vite and Supabase. Run on that laptop (SSH access to the Host must already be enabled), then open the share URL in its browser:

```bash
ssh -N -L 5173:127.0.0.1:5173 -L 55421:127.0.0.1:55421 HOST_USER@HOST_LAN_ADDRESS
```

The share URL is a credential. Keep it out of screenshots/logs and do not send it through Production services. An SSH tunnel is needed because this local launcher binds API/Vite to loopback; a phone on ordinary Wi-Fi cannot directly reach it. If no second-device tunnel exists, mark RC-M3 `ENV_BLOCKED`, not `MANUAL_PASS`.

### Manual cases and pass criteria

#### RC-M1～RC-M6 實機執行表（本輪均 `NOT_TESTED`）

使用現行 repository Local launcher、一般 `member` 帳號、真實裝置與真實麥克風；先記錄裝置型號、OS、Chrome／Safari 版本、Meeting ID 與時間。歷史 isolated-workdir fallback 不屬於本輪執行路徑。Host 的 RC-M1 及跨裝置 RC-M3 優先在實機 Chrome 和 Safari 覆蓋；其餘個案記錄實際使用的瀏覽器，不以模擬 WebKit 代替 Safari 實機結果。每項均需人工操作及判讀，未執行保持 `NOT_TESTED`，環境前置失敗記 `ENV_BLOCKED`；細節與故障注入以本節下方原契約為準。

| 個案／目的及必要前置 | 實際操作與裝置／瀏覽器 | PASS／FAIL 標準 | 保存證據／人工 |
| --- | --- | --- | --- |
| **RC-M1 Host 生命週期**：member 已登入、真實麥克風授權、Local 服務正常。 | Host 實機 Chrome，另以 Safari 實機重做：建立 Meeting、說話確認來源／譯文、停止錄音→繼續、連錄超過 15 分鐘觀察 rollover、再停止→重新錄製→End。 | `MANUAL_PASS`：後繼 Segment 可見、Stop 保持 Meeting 開放且可再錄、End 後完成且禁錄；任一必要轉換失敗為 `FAIL`，未觀測 rollover 不得推定通過。 | 保留每步時間、UI／Console、前後 Segment ID、Cue／Checkpoint／PCM Journal／OPFS 回讀與 End 後狀態；**人工：是**。 |
| **RC-M2 字典生效**：member Meeting 可編輯字典、麥克風可用。 | Host 實機記錄瀏覽器版本：新增／編輯並套用詞條，Pause、改詞、Continue、說出該詞，查新 Cue。 | `MANUAL_PASS`：繼續後實際譯文採用新設定且未建立舊 cloud Recording Session；僅儲存詞條、未驗證譯文或結果不符為 `FAIL`／`NOT_TESTED`。 | 詞條修訂版、遮蔽後的來源與譯文 Cue、操作時間及 Network 證據；**人工：是**。 |
| **RC-M3 跨裝置 Viewer**：Host member Meeting、有效 Viewer share、第二實機及可用的安全連線／網路切換。 | Host 與第二裝置 Viewer 分別記錄 Chrome／Safari 版本；中途加入，核對雙語 Cue，切斷並恢復 Viewer 網路，檢查補播，再做 Host Stop、Continue、End。 | `MANUAL_PASS`：重連補齊漏失 Cue 且無重複，Stop 時仍顯示開放 Meeting，End 顯示結束；任一轉換錯誤為 `FAIL`。第二裝置無法連至 Local 服務為 `ENV_BLOCKED`。 | 雙裝置時間戳、transport 狀態、Cue sequence、去識別截圖與 Network／授權結果；**人工：是**。 |
| **RC-M4 本機恢復**：同一 Host 瀏覽器 profile 保留 IndexedDB／OPFS，member Meeting 已錄製。 | Host 實機記錄瀏覽器版本；分別在錄製中、Pause 後、rollover 後、End 後重新載入並核對本機資料。 | `MANUAL_PASS`：Segment／Cue 恢復、無重複 MediaRecorder／Segment，且 Network 無舊 cloud Cue／Transcript／Checkpoint 下載；任一不符為 `FAIL`，清除瀏覽器儲存須另列環境損失。 | Reload 前後 Segment／Cue／Checkpoint／Journal／OPFS 計數、Console 與 Network；**人工：是**。 |
| **RC-M5 End 失敗恢復**：獨立 Local Meeting、可用 Host DevTools、可讀本機留存與隔離 DB。 | Host 實機記錄瀏覽器版本；依下方單次攔截器注入一個 End 503，End、Reload、允許重試，再查本機與唯讀 DB。 | `MANUAL_PASS`：Network 恰一個注入 503，本機 `stopped_local` 且 PCM 封存，重試後 DB `completed`、版本只加一次、`purge_at - ended_at = 1800` 秒，無新 Recorder／Segment；否則 `FAIL`。 | 遮蔽後 Network 503、IndexedDB retention、Console、唯讀 DB 狀態與時間；**人工：是**。 |
| **RC-M6 30 分鐘留存**：獨立已 End Meeting、可等待實際期限並檢查本機與隔離 DB。 | Host 實機記錄瀏覽器版本；期限前讀取／下載，真實等待 30 分鐘後查拒讀與 IndexedDB／OPFS 清理；另做關閉瀏覽器跨期限重開及下方本機清理失敗一次再重試。 | `MANUAL_PASS`：DB `purge_at - ended_at = 1800` 秒、到期後拒讀、補償清理成功且 Meeting 設定／字典保留；任一缺失為 `FAIL`。不得改系統時間或縮短期限。 | 期限前後時間、讀取／下載結果、IndexedDB／OPFS 前後、失敗與重試紀錄、唯讀 DB metadata；**人工：是**。 |

Use a separate Meeting for destructive timing/fault tests when needed. Record timestamp, browser/version, Host/Viewer device, Meeting ID, each action, actual result, Console/Network/DB evidence, and one of `MANUAL_PASS`, `FAIL`, `ENV_BLOCKED`, `NOT_TESTED`. Screenshots must hide keys, tokens, and share URLs.

1. **RC-M1 Host lifecycle:** Create Meeting; start the real microphone; speak and see source plus translation; Pause; Continue; record continuously for **more than 15 minutes** and see a new local Segment after rollover; Stop; start recording again; End. `MANUAL_PASS` requires Stop to keep Meeting open and allow another recording, while End disables further recording and leaves one completed Meeting. Capture local Segment IDs before/after rollover and after Stop/End. A failed or unobserved rollover is `FAIL` or `NOT_TESTED`, never inferred from elapsed time alone.
2. **RC-M2 dictionary:** Create and edit a glossary entry; attach it to the Meeting; Pause; change the term; Continue; speak the term and confirm the new translation actually appears. Record term/revision and resulting cue (redact sensitive text). `MANUAL_PASS` requires the new setting to be used by resumed capture, without an old cloud Recording Session. A saved entry alone is insufficient.
3. **RC-M3 Viewer:** Join mid-meeting from the second device; verify source/translation; disconnect and restore Viewer network; verify reconnection and missed-cue replay without duplicates. Host Stop must leave Viewer in an open Meeting state; Host End must show ended state. Record both devices' transport status and cue sequence. `MANUAL_PASS` requires every transition, not only initial join.
4. **RC-M4 recovery:** During recording reload Host and confirm local recovery; repeat after Pause, after rollover, and after End. Verify restored Segment/cues and no duplicate MediaRecorder/Segment creation. Network inspection must show no old cloud Cue/Transcript/Checkpoint download. If browser storage was cleared, classify environment loss separately.
5. **RC-M5 End failure:** On an isolated local Meeting only, install the one-request interceptor below in the Host console, click End once, and confirm the Network trace shows exactly one injected 503. The interceptor restores `fetch` before returning that response, so the next request is real. Confirm local state is `stopped_local`, audio/PCM is sealed, and IndexedDB retention has `pendingCompletion` plus a fixed 30-minute `expiresAt`. Reload, allow the retry, then run the read-only DB check below: `completed`, `ended_at`, lifecycle version incremented exactly once, and `purge_at - ended_at = 1800` seconds. No new MediaRecorder or Segment may appear. A pre-commit 503 tests failed metadata completion; the existing `issue41RealEndRecovery.spec.js` separately covers a committed-but-lost response.
6. **RC-M6 retention:** After End, verify the local deadline is exactly 30 minutes from local seal and DB `purge_at` exactly 1800 seconds from `ended_at`. Test reads/downloads just before and after expiry, then inspect IndexedDB and OPFS for cleanup. Repeat with browser closed over expiry and reopen; retry a deliberately failed local cleanup after removing the local failure condition. Verify Meeting settings and glossary remain in Supabase. `MANUAL_PASS` requires access denial after expiry, local cleanup compensation, and preserved metadata. Do not shorten Production retention or alter system clock to make this pass.

RC-M5 single-failure injection, run only on `http://127.0.0.1:5173` after replacing the Meeting ID. If a 503 is not seen, mark the injection `FAIL` and do not infer the recovery path passed:

```js
const meetingId = 'REPLACE_WITH_MEETING_UUID';
if (location.origin !== 'http://127.0.0.1:5173') throw new Error('Isolated Host only');
const originalFetch = window.fetch;
window.fetch = function (input, init) {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const method = (init?.method || input?.method || 'GET').toUpperCase();
  if (url.pathname === `/api/meetings/${meetingId}/complete` && method === 'POST') {
    window.fetch = originalFetch;
    return Promise.resolve(new Response('{"error":{"code":"injected_end_failure"}}', {
      status: 503, headers: { 'Content-Type': 'application/json' }
    }));
  }
  return originalFetch.apply(this, arguments);
};
```

Read local state without changing it, in the Host console before and after reload (replace ID). Record only state, Segment ID, pending status, and deadline, not transcript content:

```js
const meetingId = 'REPLACE_WITH_MEETING_UUID';
const { createLocalMeetingPersistence } = await import('/src/lib/localMeetingPersistence.js');
const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
const local = await createLocalMeetingPersistence().restore(meetingId);
const retention = await createIndexedDbLocalMeetingManifestStore().getRetention(meetingId);
console.table({ recordingState: local?.recording?.state, segmentId: local?.recording?.segmentId,
  pendingCompletion: Boolean(retention?.pendingCompletion), sealedAt: retention?.pendingCompletion?.sealedAt,
  expiresAt: retention?.expiresAt });
```

For RC-M6 cleanup retry, close the Host browser before expiry. After the real 30-minute deadline, open the same-origin static asset `http://127.0.0.1:5173/google-g.svg` in that browser profile so the App cannot perform its startup cleanup first. In DevTools console, run this isolated-only, one-attempt local failure followed by the real cleanup. It uses the real IndexedDB retention record and real cleanup on retry; the first attempt injects a failure before OPFS deletion. Do not run it before expiry or on any non-local origin:

```js
const meetingId = 'REPLACE_WITH_MEETING_UUID';
if (location.origin !== 'http://127.0.0.1:5173') throw new Error('Isolated browser only');
const { createLocalMeetingRetention } = await import('/src/lib/localMeetingRetention.js');
const { createIndexedDbLocalMeetingManifestStore } = await import('/src/lib/localMeetingStorage.js');
const store = createIndexedDbLocalMeetingManifestStore();
const before = await store.getRetention(meetingId);
if (!before || Date.parse(before.expiresAt) > Date.now()) throw new Error('Wait for actual expiry');
const failed = await createLocalMeetingRetention({ manifestStore: store,
  chunkStore: { removeMeeting: async () => { throw new Error('injected_local_cleanup_failure'); } }
}).check(meetingId);
const retryable = await store.getRetention(meetingId);
const retried = await createLocalMeetingRetention({ manifestStore: store }).check(meetingId);
const cleared = await store.getRetention(meetingId);
console.table({ firstFailed: failed.failed, retryRecorded: Boolean(retryable?.cleanupError),
  secondCleared: retried.cleared, physicalCleared: Boolean(cleared?.physicalCleared) });
```

Require `firstFailed=1`, `retryRecorded=true`, `secondCleared=1`, `physicalCleared=true`; then inspect OPFS/IndexedDB in DevTools and reopen Host. If the App already cleared the record or the static asset is unavailable, mark this subcase `NOT_TESTED` and retain the actual observations.

### Read-only DB evidence and contract gates

The following script uses `BEGIN READ ONLY`; it emits status/counts, never keys, token hashes, cue text, or audio. Run only against the isolated DB container printed at setup; an empty Meeting result or missing container is `ENV_BLOCKED`/`FAIL`, not PASS.

```bash
cd /Users/pochun/projects/live-translate
export RC_DB_CONTAINER=supabase_db_issue41-manual-REPLACE_ME
export RC_MEETING_ID=REPLACE_WITH_MEETING_UUID
case "$RC_DB_CONTAINER" in supabase_db_issue41-manual-*) ;; *) echo 'Not an isolated RC DB'; exit 1;; esac
docker exec -i "$RC_DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -v meeting_id="$RC_MEETING_ID" -U postgres -d postgres < scripts/issue41-manual-readonly.sql
```

All six content counts must be zero **for the new Meeting**, and active Viewer shares must have the intended role and unexpired, unrevoked state. Counts alone do not prove write denial. Run the existing transaction-rollback contracts against the same isolated DB, when Auth/PostgREST/DB are healthy:

```bash
docker exec -i "$RC_DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < tests/integration/issue41LocalOnlyCutover.sql
docker exec -i "$RC_DB_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < tests/integration/issue41UnifiedLifecycle.sql
```

These two SQL contracts write temporary fixtures inside a rolled-back transaction; they are **not read-only** and must never run on Production. Their assertions cover DB/RPC/Storage local-only denial and lifecycle semantics. Also retain the existing ownership/share authorization tests and a real isolated-DB share check; a working Viewer UI by itself does not prove authorization. Existing `issue41DbWriteAudit.js` installs audit triggers and is not a read-only command. If its automatic run is blocked, report zero-write history as `NOT_TESTED` even if the read-only snapshot is clean.

### Evidence record and final decision

Save a local report under `test-results/issue41-manual/` (ignored by Git). Create a timestamped record, then fill one row per case:

```bash
mkdir -p test-results/issue41-manual
RC_REPORT="test-results/issue41-manual/$(date +%Y%m%dT%H%M%S%z).md"
cat > "$RC_REPORT" <<'EOF'
# Issue 41 manual RC evidence
RC1_VERDICT: BLOCKED
RC_MANUAL_FALLBACK_VERDICT: READY_NOT_EXECUTED
Isolated workdir / DB container: [fill]
Automated contracts (command, exit code, redacted output path): [fill]

| Case | Executed at + timezone | Browser/version | Host / Viewer device | Meeting ID | Steps | Expected | Actual | Result | Console / Network / DB evidence |
|---|---|---|---|---|---|---|---|---|---|
| RC-M1 | | | | | | | | NOT_TESTED | |
| RC-M2 | | | | | | | | NOT_TESTED | |
| RC-M3 | | | | | | | | NOT_TESTED | |
| RC-M4 | | | | | | | | NOT_TESTED | |
| RC-M5 | | | | | | | | NOT_TESTED | |
| RC-M6 | | | | | | | | NOT_TESTED | |
EOF
printf 'Report: %s\n' "$RC_REPORT"
```

Use `MANUAL_PASS` only for an executed full case; `NOT_TESTED` for untouched cases; `ENV_BLOCKED` only for a documented local environment failure. Include exact command, exit code, and redacted output path for each automated contract. Report `RC_MANUAL_FALLBACK_VERDICT=PARTIAL_EVIDENCE` until all required manual cases and independent security contracts pass. Keep `RC1_VERDICT=BLOCKED` and Production release blocked while Realtime/environment preflight, required DB/RPC/Storage contracts, or any required RC case remains unresolved; never promote a Realtime FAIL to PASS.

## Issue #41 local integration startup

Set `LOCAL_SUPABASE_WORKDIR` to a separate workdir containing `supabase/config.toml` and `supabase/migrations`; the repository root is rejected. Run `npm run start:local -- --check` to verify Docker, local Supabase, repository migrations, loopback Redis, and required auth configuration without starting the app. Then run `npm run start:local` for the Node API and Vite frontend. Both processes receive the same loopback Supabase URL and local keys, overriding cloud values in the shell and `.env*`. The startup gate requires a distinct project ID, matching loopback API/DB ports, identical migration files, and exact applied migration history. It does not reset or migrate the database. Production `npm start` is unchanged. Stop both local processes with Ctrl-C.

## Issue #41 SSH-independent local runner

The API selects the Supabase-backed repository whenever a loopback Supabase URL and secret key are configured, including tests that leave `GEMINI_API_KEY` empty. A successful Meeting create must therefore persist Owner metadata before returning `201`.

Each Local Core run generates a validated `issue41_audit_<24 hex>` namespace and checks that it does not exist before starting Chromium. The test verifies trigger coverage for every expected public table and `storage.objects`, then reads writes only from that run's namespace. `evidence.json` and `verdict.json` retain the namespace and coverage; the runner does not clean up audit schemas. On a reused DB, earlier enabled audit triggers also record later writes, so use another isolated DB when earlier audit results must stay unchanged.

For the Phase L2 short Chromium acceptance on an already running isolated stack, use
`LOCAL_SUPABASE_WORKDIR=<isolated-workdir> LOCAL_REDIS_URL=redis://127.0.0.1:<local-port> node scripts/issue41-local-core-acceptance.mjs` from Mac Terminal. The runner rechecks the existing stack and starts test-mode API, Vite, and signaling processes; ports 3000, 3001, and 5174 must be free. It creates a Local Auth test user and an audit schema in that isolated DB, but never resets, migrates, or stops the stack. Gemini is mocked; Chromium, Local Auth, APIs, Redis signaling, IndexedDB/OPFS, and DB write audit are real. The runner writes `verdict.json` under `test-results/issue41-runner/core-*/`. Use `--plan` for a service-free path check.

From this worktree, start a detached run with `node scripts/issue41-local-runner.mjs start`.
For the real-time, database-backed Issue #41 case, use `start --real-time`.
That option always starts an isolated local Supabase stack, creates a local
Supabase Auth user, and runs `issue41RealtimeSoak.spec.js` once with the
production 15-minute rollover interval. `start --real-time --short-validation`
runs the same real API/DB/Viewer path but ends before rollover; its result is
`short-validation-passed`, never a rollover pass. Neither mode calls Gemini:
the E2E Vite alias provides the fake browser provider and only `/api/live-token`
is intercepted to avoid token creation against Gemini. Meeting, Session,
Segment, Cue, checkpoint, and Viewer APIs are real local services.

Use `start --supabase` only when an isolated local Supabase stack is needed;
`--supabase-port-base=55421` changes its reserved port range. The E2E cases
use the existing fake Gemini browser provider and mocked Meeting endpoints;
starting Supabase does not turn these cases into a database integration test.
The runner rejects occupied API/Vite ports (3000/5174), never reuses their
servers, and never calls a real Gemini API. Supabase gets a unique project ID,
copied migrations, and its own ports under the run directory.
For real-time Host/Viewer runs, the runner starts a dedicated loopback Redis on
16379 only when the port is free, verifies its PID, configuration, and empty DB 15,
then stops only that verified instance after the run.

```bash
node scripts/issue41-local-runner.mjs start
node scripts/issue41-local-runner.mjs start --real-time --short-validation
node scripts/issue41-local-runner.mjs start --real-time
node scripts/issue41-local-runner.mjs status
node scripts/issue41-local-runner.mjs report
node scripts/issue41-local-runner.mjs stop
```

For the isolated WAV microphone gate, run `node scripts/issue41-local-runner.mjs start --local-preflight`.
This uses API `127.0.0.1:31041`, Vite `127.0.0.1:5175`, signaling `127.0.0.1:31042`,
Redis `127.0.0.1:16379/15`, a per-run loopback Docker network, and a newly created Local Supabase
project. It verifies the complete copied migration manifest and the current B2-L SQL contracts,
then checks Local Auth, API/Frontend startup, Redis-backed Host/Viewer signaling, and Chromium WAV
PCM through the production Recorder input controller. It does not run the longer Host/Viewer soak or
call Gemini. Results and the generated WAV stay under
`test-results/issue41-runner/<run-id>/`.
If Docker publishes any Supabase port outside `127.0.0.1` or `::1`, or the macOS host listens on
a non-loopback address, the Runner records the binding and listener evidence,
stops its own stack, and reports `ENVIRONMENT_BLOCKED`. Fix the host Docker port binding before
running either audio mode.

For one short real-provider run, enter a **test-only** Key through the terminal without shell history
or a Key file, then start the same Runner:

```zsh
read -s 'ISSUE41_TEST_GEMINI_KEY?Test Gemini Key: '; echo
export ISSUE41_TEST_GEMINI_KEY
node scripts/issue41-local-runner.mjs start --real-gemini-audio-smoke
unset ISSUE41_TEST_GEMINI_KEY
```

If the real Gemini audio smoke reaches a Local Cue mutation failure, inspect
`test-results/issue41-runner/<run-id>/cue-mutation-diagnostics.json`. It records only
mutation stage/type, Cue/Segment/operation IDs, batch count/index, safe rejection reason,
root error name/code, IndexedDB transaction state, and sanitized application stack locations.
The same artifact is written inside that test's
Playwright output; the Run-level copy remains separate from Playwright output cleanup.

The detached worker inherits the Key only in memory, enters it into the current settings page,
and uses the actual Gemini Live browser provider. Do not use a user browser profile or a production Key.
Use `node scripts/issue41-local-runner.mjs status <run-id>` and `report <run-id>` to inspect progress.
`LOCAL_SMOKE_ENV_VERDICT` and `VIRTUAL_MIC_VERDICT` do not imply
`REAL_GEMINI_AUDIO_SMOKE_VERDICT=PASS`; unobserved late-final and non-prefix revision stay `NOT_OBSERVED`.
The environment verdict reflects completed local setup and preflight checks, even if the later
real Gemini audio assertion fails.

Commands also accept a run ID after the verb. `start` prints the ID and report
path. The runner first executes the existing three-segment rollover E2E Smoke.
If it passes, the existing 13-segment accelerated E2E test repeats until at
least 20 minutes of wall-clock soak have elapsed. A failed iteration stops the
sequence. Each phase keeps its log, exit code, and Playwright trace/artifacts
under `test-results/issue41-runner/<run-id>/`; `runner.log`, `state`, and
`exit-code` record the overall outcome. The detached worker ignores terminal
hangup and has no SSH stdin or stdout; verify SSH survival separately by
disconnecting and reconnecting to the remote Mac, then checking `status` and
the growing `runner.log`. `stop` signals only the recorded worker, which stops
its own child process group and its own optional Supabase project.
Real-time runs also save `git-sha`, `auth-user-id`, `supabase-url`,
`evidence.json` (Meeting/Session/Segment IDs, DB Cue sequence and checkpoint
revision, Viewer text and PCM counts), API/Playwright logs, trace, PID, and
exit code. The runner redacts Auth tokens and Supabase keys from text reports
and Playwright traces before finalizing a run.

Live pipeline trace vocabulary: use `TRANSCRIPT_NORMALIZED`, `TURN_ASSIGNED`, `CUE_CREATED`, `CUE_UPDATED`, `CUE_FINALIZED`, `CUE_PUBLISHED`, `SPEECH_ACTIVITY_STARTED`, `SPEECH_ACTIVITY_CONTINUED`, `LOCAL_SILENCE_DETECTED`, and lifecycle reconnect/rollover stages. Legacy `NORMALIZED`, `CUE_STATE`, and `LOCAL_SILENCE_FINALIZE` names are not canonical. `audioTurnId` is authoritative at the audio boundary; `turnKey` belongs to normalized logical turns; `cueId` belongs to Cue state. Diagnostics never use one identity as another's fallback.

## WebRTC 正式流程

最小自動化驗證：

```bash
node --test tests/unit/webrtcSignalingRoute.test.js tests/unit/webrtcSubtitleDataChannel.test.js tests/unit/webrtcSubtitleTransport.test.js tests/unit/viewerLongSessionRecovery.test.js tests/unit/meetingViewerSnapshot.test.js tests/unit/meetingViewerState.test.js tests/unit/meetingViewerRealtime.test.js tests/unit/webrtcPocPage.test.js
node --test tests/integration/webrtcLateJoin.integration.test.js
npm run build
```

`webrtcSubtitleTransport.test.js` 另覆蓋 Viewer 在 Recorder 出現前持續 discovery、等待期間累積的同一 `viewerId + negotiationId` `viewer-ready` backlog 只建立一個 in-flight PeerConnection／offer、Device 成功 join 重設 recovery budget，以及 persistence 故障域隔離：已開啟的
DataChannel 在 signaling heartbeat 回 `503` 時不得 teardown、不得切換為
`reconnecting`，Cue 2／Cue 3 必須沿用同一 transport generation 繼續發布；雲端
control-plane 恢復後只恢復 heartbeat，不得重複發布已送達的 Cue。

`webrtcLateJoin.integration.test.js` 使用 fake clock 驗證 Recorder 維持 60 分鐘 signaling lease 後，第一個 Viewer 仍能完成定向 `viewer-ready -> offer`；這不等同真實 60 分鐘手機測試。

這些測試涵蓋 Viewer code/token 分流、Device `canRecord` 授權邊界、拒絕 expired/revoked/mismatch/stopped、Viewer 禁止 offer/stop、participant heartbeat、8 秒 signaling timeout、暫時 poll 失敗、5 秒 disconnected grace、ICE restart、DataChannel close/error、舊 epoch、6 次重試耗盡、Realtime token refresh 與故障 reconnect timer 隔離、reconnect snapshot/replay、Segment sequence domain、snapshot 503 retry、same-source replay、sidecar 清理與 Cue 去重。跨網路實機仍依 [WebRTC Preview runbook](verification/webrtc-browser-deployment.md) 執行，不得以單元測試替代。

## Vercel Relay PoC verification boundary

The Relay PoC is documentation and operator validation only in this round; it
does not modify production code or enable a paid Vercel/Upstash plan. Keep the
following evidence classes separate:

- **Automated local proof:** run the existing local-device unit/E2E commands
  and `git diff --check`. This proves browser-to-local-device packet
  persistence, ACK/idempotency, reconnect backfill, and stop behavior only.
- **Preview/account proof:** requires a real Vercel Preview deployment, an
  Upstash Redis account/database, configured Preview environment variables,
  and an approved HTTPS/network path. It must exercise the two-hour relay
  matrix in [local-device-poc.md](verification/local-device-poc.md): Function
  expiry, redeploy, Viewer reconnect, and independent relay versus recording
  lifecycle heartbeats.
- **Not proven by this round:** production deployment, paid-plan activation,
  cross-network device reachability, exactly-once Pub/Sub delivery, durable
  subtitle history in Redis, or cloud audio storage/download. Audio download
  remains a future host-authorized range endpoint against the local permanent
  source.

The relay test report must state that Redis Pub/Sub is routing only (not
Streams), the registry has metadata only and no socket references, Redis has
no subtitle history, and a publisher ACK means `PUBLISH` completed—not Viewer
render or durable receipt. Include `requestId`, timeout/retry outcome,
deployment ID, account/region, Viewer count, and the exact source snapshot
used for recovery. Do not put REST tokens, ephemeral tokens, raw audio, or
transcript payloads in the report.

For cost/quotas and the formula for a two-hour meeting at different Viewer
counts, use the operator section in [local-device-poc.md](verification/local-device-poc.md)
and verify live limits at the linked official Vercel and Upstash pricing pages.

## Phase 0 contract evidence

Test the browser as the only OPFS reader, immutable chunk checksums, four
durable pending queues (`cue`, `checkpoint`, `operation`, `audio`), ACK loss
and resend, duplicate idempotency, stale fence/version/hash conflicts, and
the recovery order: operations, dependent checkpoints/Cues, then audio.
Queues must ACK independently so audio failure does not block Cue/checkpoint
delivery and vice versa.

Evidence must separately prove that stopping a Meeting immediately invalidates
Viewer/Recorder shares, while the authenticated host alone can export
TXT/SRT/VTT and download completed audio for 30 minutes. Origin/CORS tests
cover only approved Preview and Production origins.

Existing failures, skipped checks, and environment blockers are non-passing
baseline evidence. Reports must retain the command, result, and blocker; they
must never label a failed or blocked run as `baseline passed`. Phase 1 physical
acceptance is still pending for Mac/Windows microphones, reload/crash queue
recovery, OPFS quota/offline resend, audio loss/recovery, and deployed
Origin/CORS checks.

## Google Workspace accounts

Google OAuth is not automated in the regular E2E suite. Deterministic identity tests cover exact email-domain matching, pending profile auto-activation, missing/update failure rejection, disabled-account rejection, and super-admin role preservation using signed JWT fixtures and mocked Supabase responses.

## Domain auto-activation coverage

Deterministic tests cover transient pending provisioning, trusted `pending -> active`, concurrent disable behavior, `/api/profile` fail-closed responses, removed approval UI/API, Meeting authorization, anonymous Viewer access, and existing active/disabled management. Tests do not call Google OAuth, Gemini, or production APIs.

## CI and cloud validation

Pull requests and pushes to `main` run `.github/workflows/ci.yml` for syntax, build, security/cloud boundary, Issue #33 account permissions, durable worker, and Viewer checks. `.github/workflows/supabase-migrations.yml` starts a local Supabase stack, resets the database, and lints all migrations. It does not connect to a Supabase cloud project.

Vercel's Git integration creates the Preview deployment. `.github/workflows/vercel-preview-check.yml` listens for a successful Vercel Preview deployment and runs the read-only deployment preflight against its URL. It does not deploy a second copy or call Gemini.

## Local staging-equivalent validation

Run staging-equivalent checks against the local Supabase stack and local backend:

```bash
npm run db:start
npm run db:reset
npm run db:lint
npm run test:integration
npm run test:e2e
```

These local tests do not call the Gemini production API. Local Supabase validates migrations, RLS, and the local data flow only; it does not replace confirmation that the production Supabase deployment and connections are configured correctly.

For an additional deployment preflight after starting the local server, run:

```bash
SMOKE_BASE_URL=http://127.0.0.1:3000 npm run test:deployment-preflight
```

## Issue #35 local RLS matrix

After local Supabase is running, execute the real PostgREST/Auth allow/deny matrix:

```bash
eval "$(supabase status -o env)"
RUN_SUPABASE_RLS_TESTS=true \
SUPABASE_TEST_URL="$API_URL" \
SUPABASE_TEST_PUBLISHABLE_KEY="$ANON_KEY" \
SUPABASE_TEST_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
npm run test:integration:supabase-rls
```

The test creates disposable local users and removes them with the service-role admin endpoint. It rejects non-local URLs unless `ALLOW_REMOTE_RLS_TESTS=true`; it never prints credentials or transcript data.

## Manual cloud validation

Cloud checks are split by deployment risk:

- Local E2E keeps its existing local backend and Vite web servers.
- Staging cloud smoke is not enabled in GitHub Actions; use the local staging-equivalent validation above. The retained `tests/cloud/stagingSmoke.spec.js` is an optional asset for a future cloud check.
- Production preflight is unauthenticated and read-only. It verifies health, readiness, private API auth, metrics auth, and worker auth. It does not create data or process the queue.

## Issue #37 Phase 2 Viewer pagination

The deterministic Viewer pagination checks cover cursor validation, latest-100
windowing, older-page merging, and the bounded Supabase joined Cue query:

```bash
node --test tests/unit/meetingViewerPagination.test.js \
  tests/unit/supabaseMeetingViewerPage.test.js
```

## Issue #37 Phase 1 lifecycle v2

The deterministic unit checks cover HTTP forwarding/conflict mapping, API
client payloads, domain mapping, and migration invariants:

```bash
node --test tests/unit/meetingLifecycleHttpApi.test.js \
  tests/unit/meetingLifecycleMigration.test.js \
  tests/unit/meetingLifecycleWriteFence.test.js \
  tests/unit/meetingLifecycleV2TranscriptBoundary.test.js \
  tests/unit/meetingAudioStorage.test.js \
  tests/unit/supabaseMeetingAudioService.test.js \
  tests/unit/workerEndpoint.test.js \
  tests/unit/meetingCheckpointApiClient.test.js \
  tests/unit/meetingDomain.test.js
```

This focused suite covers the 15-minute CRON expiration RPC, 30-minute
retention-claim contract, terminal-write rejection, v2 transcript boundary,
upload-start fencing, and pre-purge audio completion/failure. It does not run a
purge deletion job, call Gemini, or contact a remote Supabase project.

With local Supabase running and its environment loaded, the focused integration
test verifies concurrent start idempotency and competing rollover/stop behavior:

```bash
RUN_SUPABASE_LIFECYCLE_TESTS=true \
node --test tests/integration/meetingLifecycleV2.integration.test.js
```

Neither command calls Gemini or a remote Supabase project.

## Issue #37 Phase 0 recording diagnostics

Staging performance runs may opt in to the redacted browser diagnostics API by
building the frontend with the private Vercel variable
`LIVE_TRANSLATE_DIAGNOSTICS=true`. Vite injects only a boolean build constant;
the environment variable itself is never read by browser code. This flag
exposes numeric recorder/upload metrics and the sanitized LiveSession snapshot;
it does not enable verbose Live event logging or expose transcript text, tokens,
signed URLs, or audio payloads. Production must leave the flag unset.

Run three paired five-minute recordings in both Chrome on macOS and Safari on
macOS. Each pair uses the same staging Meeting, microphone, network condition,
and short speech script: one recording-off control, followed by one
recording-on treatment. Include one pause/resume treatment pair and wait for
the final audio artifact to reach a terminal status before collecting the
snapshot.

At the end of each run, collect:

- `window.__liveTranslateRecordingDebug.getSnapshot()`
- `window.__liveTranslateDebug.getSnapshot()`
- browser, OS, browser version, commit/build identifier, and run mode

Compare treatment runs with their control. Treat two or more treatment runs
with a callback-gap p95 increase above 20%, a new 500ms-or-longer gap, or any
audio loss/recovery failure as evidence for the OPFS gate. The default
15-minute segment rollover is not exercised by a five-minute run; rollover
upload contention therefore remains explicitly unverified.

```bash
SMOKE_BASE_URL=https://production.example.com npm run test:cloud:preflight
```

For staging authenticated reload coverage, provide a non-production staging URL, matching Supabase URL, and disposable owner token. The browser test injects the Supabase session directly and never automates Google OAuth:

```bash
CLOUD_BASE_URL=https://staging.example.com \
CLOUD_SUPABASE_URL=https://staging-project.supabase.co \
CLOUD_TEST_ACCESS_TOKEN="$STAGING_TEST_ACCESS_TOKEN" \
npm run test:e2e:cloud -- tests/cloud/issue35Reload.spec.js tests/cloud/stagingSmoke.spec.js tests/cloud/issue35BrowserReload.spec.js
```

Run the no-Gemini Storage/export lifecycle separately when staging worker and private Storage evidence are available:

```bash
npm run test:e2e:cloud -- tests/cloud/issue35StorageLifecycle.spec.js
```

The manual workflow `.github/workflows/cloud-validation.yml` is production-only and requires `PRODUCTION_BASE_URL`. It does not require staging secrets. Real Gemini smoke remains a separate explicit opt-in.

## Account permissions

Account role management uses the following deterministic service, HTTP, migration, domain-activation, and browser checks:

```bash
node --test tests/unit/adminService.test.js tests/unit/auditLogService.test.js tests/unit/accountRoleHttpApi.test.js tests/unit/accountRoleManagementMigration.test.js tests/unit/domainAutoActivationMigration.test.js tests/unit/profileService.test.js
npx playwright test --config tests/e2e/playwright.config.js tests/e2e/accountRoleManagement.spec.js
```

After local Supabase migrations are applied, run the real concurrent cross-demotion regression:

```bash
RUN_SUPABASE_ROLE_TESTS=true node --test tests/integration/accountRoleConcurrency.integration.test.js
```

It starts two active `super_admin` profiles, concurrently attempts A→B and B→A demotions, and verifies exactly one succeeds, at least one administrator remains, the loser receives `auth_forbidden`, and only the successful audit event exists.

Coverage includes actor/resource-owner separation, disabled-profile refresh, member recording scope, owner-only private resources, atomic transfer rollback, credential exclusion, and safe audit failures. Local DB validation uses `supabase migration up --local` followed by `supabase db lint --local`.

Run the deterministic Issue #33 coverage without production Supabase or Gemini:

```bash
node --test tests/unit/meetingMembership.test.js tests/unit/adminService.test.js tests/unit/auditLogService.test.js tests/unit/profileService.test.js tests/unit/profileHttpApi.test.js tests/unit/dualWriteTranslationExecutionQueue.test.js tests/integration/accountPermissions.integration.test.js
npx playwright test --config tests/e2e/playwright.config.js tests/e2e/accountPermissions.spec.js
```

The account E2E seeds a deterministic Supabase session in browser storage and mocks every account API response.

P1 identity tests use signed deterministic JWT fixtures and never call Google,
Gemini, or Supabase production services. Validate the identity slice with:

```bash
node --test tests/unit/accessControlSupabase.test.js tests/unit/accessControl.test.js tests/unit/accessToken.test.js
npm run build
npm run db:lint
```

## Realtime subtitle pipeline strategy (P0 and P1 implemented)

The four-stage pipeline is documented as a deterministic, mockable boundary.
P0 currently implements the voice transcription and finalized Cue stages;
initial Flash translation and refinement run asynchronously after finalized Cue persistence:

```text
finalized source Cue → initial Flash translation → Flash refinement
```

Interim events are UI-only. They must never appear in persistence, downstream
execution input, refinement context, export, history, or summary fixtures.
Real Gemini smoke tests are opt-in only (`ENABLE_REAL_GEMINI_TEST=true`); unit,
integration, and E2E coverage must use fixtures or provider mocks by default.

Focused coverage:

- Voice: PCM conversion, AudioContext recovery, AudioWorklet-compatible capture,
  playback failure isolation, output sink selection, and active microphone replacement.

- Unit: interim/finalized separation, immutable Cue fields, same-Cue updates,
  effective-translation fallback, duplicate handling, and stale-event rejection.
- Integration: `final_cue.persisted` through initial translation and refinement,
  including structured-output validation, failure isolation, idempotency, and
  version fencing.
- E2E: show the initial translation first, then update the same visible Cue row
  in place when refinement completes.
- Lifecycle: start/pre-roll, first sentence, pause/resume, reconnect, rollover,
  terminal flush, and no loss or late overwrite of finalized Cues.

This project separates deterministic tests from real Gemini API validation. Unit,
integration, and E2E tests must not call the real Gemini API. The live smoke test
is opt-in only.

Issue #29 Milestone 1 coverage includes Meeting home route behavior, status
mapping, search/filter rules, and Meeting Management E2E flows. Later coverage
will add independent Viewer snapshot/SSE, Cue deduplication, ordering,
and reconnect merge. The Viewer latency SLA will use a local deterministic
synthetic broadcaster test; it must not call Gemini or overwrite full benchmark
reports. See [Meeting Center and Live Viewer](features/meeting-center-live-viewer.md).

Milestone 5 realtime coverage includes Meeting broadcaster sequencing and
bounded replay, Cue publish HTTP authorization, Meeting Viewer SSE delivery,
snapshot gap recovery, duplicate/refinement merge, and deterministic latency
measurements.

Issue #29 UI consolidation coverage includes canonical independent Setting,
Live, History Detail, and Viewer routes, plus global/private glossary
boundaries.

Global glossary UI coverage includes card-grid filtering, category counts,
multi-language editing, enabled-state and delete batch actions, and the side drawer. The
global page manages only entries shared by all Meetings; private entries remain
covered by the Meeting glossary drawer tests.

Global glossary import coverage includes CSV/JSON parsing, row validation,
preview conflict detection, selected-row imports that skip invalid rows,
revision conflicts, and atomic all-or-nothing commits.

Meeting glossary import coverage includes private CSV/JSON/XLSX preview,
duplicate and conflict handling, staged form merging, and persistence through
the existing Meeting settings save request.

Run the focused realtime tests:

```bash
node --test tests/unit/meetingEventBroadcaster.test.js tests/unit/meetingViewerState.test.js tests/unit/meetingCheckpointHttpApi.test.js
npx playwright test --config tests/e2e/playwright.config.js tests/e2e/sessionSharing.spec.js
```

## Test Responsibility Boundaries

- Unit tests own pure rules, state transitions, input matrices, and failure
  classification.
- Integration tests own HTTP, composition, persistence, and provider adapter
  boundaries.
- E2E tests keep representative browser journeys and browser-only wiring; pure
  Cue merge and display matrices belong in unit tests.
- The live smoke test only checks an explicitly enabled real Gemini connection.

`npm test` is the canonical unit-test entry point and is equivalent to
`npm run test:unit`. Legacy top-level audio and token tests were consolidated
into the unit suite; provider-specific token behavior remains in
`tests/unit/tokenService.test.js`.

## Unit Tests

Run the file-backed queue concurrency and persistence tests:

```bash
node --test tests/unit/fileDurableTranslationExecutionQueueRepository.test.js tests/unit/fileDeadLetterQueueRepository.test.js
```

These tests include two independent Node.js processes writing the same queue
file, concurrent claim ownership, stale sidecar-lock recovery, deterministic
JSON persistence, and the existing queue/DLQ repository contracts.

Run all unit tests:

```bash
npm run test:unit
```

Run transcript unit tests:

```bash
node --test tests/unit/transcript.test.js
```

Run transcript export unit tests:

```bash
node --test tests/unit/transcriptExport.test.js
```

Run transcript polishing unit tests:

```bash
node --test tests/unit/transcriptPolishing.test.js tests/unit/geminiTranscriptPolishingProvider.test.js
```

Run media device utility unit tests:

```bash
node --test tests/unit/mediaDevices.test.js
```

Run connection failure classification unit tests:

```bash
node --test tests/unit/connectionFailures.test.js
```

Run retry policy unit tests:

```bash
node --test tests/unit/retryPolicy.test.js
```

Run reconnect controller unit tests:

```bash
node --test tests/unit/reconnectController.test.js
```

Run LiveSession failure signal unit tests:

```bash
node --test tests/unit/liveSessionFailureSignal.test.js
```

Run frontend failure UI state mapping unit tests:

```bash
node --test tests/unit/failureUiState.test.js
```

Run session records domain model unit tests:

```bash
node --test tests/unit/sessionRecords.test.js
```

Run session repository unit tests:

```bash
node --test tests/unit/sessionRepository.test.js
```

Run session record lifecycle mapping unit tests:

```bash
node --test tests/unit/sessionRecordLifecycle.test.js
```

Run saved session export unit tests:

```bash
node --test tests/unit/sessionRecordExport.test.js
```

Run Long Meeting checkpoint and reliability unit tests:

```bash
node --test tests/unit/meetingCheckpointService.test.js
node --test tests/unit/segmentSwitchOrchestrator.test.js
```

Run the focused Auth/rollover isolation regression without a real Supabase or
Gemini request:

```bash
node --test tests/unit/authState.test.js tests/unit/accessToken.test.js \
  tests/unit/livePipelineTrace.test.js tests/unit/segmentSwitchOrchestrator.test.js \
  tests/unit/rolloverRecoveryCoordinator.test.js tests/unit/liveSessionProviderTransition.test.js

npx playwright test --config tests/e2e/playwright.config.js \
  tests/e2e/liveTranslate.spec.js \
  -g "lifecycle v2 rollover survives|keeps Recorder mounted when one-sided cues|real auth sign-out revokes|auth-invalid profile revalidation|newer same-user auth state"
```

The accelerated rollover case injects same-user `TOKEN_REFRESHED` while the
rollover request is in flight. It must preserve the mounted recorder, audio
capture, replacement Gemini session, canonical Cue persistence, and Viewer
DataChannel publication. Explicit `SIGNED_OUT` and `auth_invalid` cases must
still stop microphone capture and unmount the protected App.

Current unit coverage:

- Cue UI timecode formatting, sequence sorting, cueId upsert, single partial
  preview rendering, history final-only filtering, and follow-latest threshold

- PCM16 audio conversion and base64 byte conversion
- Linear resampling and PCM chunking
- Transcript update behavior
- Transcript export formatting
- Media device normalization, input constraints, and output-selection capability
  detection
- Connection failure classification, including token expiration readiness
- Retry policy decisions
- Reconnect controller lifecycle, cancellation, generation guard, and execution hook
- LiveSession post-cleanup failure signal integration
- Frontend failure-to-UI-state mapping for manual recovery and controlled
  reconnect, including token expiration recovery
- Session records domain model creation, finalization, transcript item mapping,
  and transcript summary behavior
- Session repository interface and in-memory adapter behavior
- Session record lifecycle mapping helpers for active record creation, final
  transcript append, and finalization
- Saved session export helpers for TXT/SRT/VTT formatting, session-relative
  timing, file naming, and unavailable export states
- Long Meeting accelerated 2+ hour checkpoint scenario coverage, including
  ordered Segment reconstruction, rollover, interrupted recovery, failed Segment
  checkpoint readability, duplicate protection, and ordering checks
- Frontend/backend language allowlist alignment
- Token request validation and token config shape

## Integration Tests

Run integration tests with the test-only Gemini mock loader:

```bash
npm run test:integration
```

Run Long Meeting file-backed vertical integration tests:

```bash
node --loader ./tests/fixtures/mockGoogleGenAiLoader.mjs --test tests/integration/meetingCheckpointVerticalIntegration.test.js
```

The loader intercepts `@google/genai`, so `POST /api/live-token` uses the real
local route handler while Gemini token creation is mocked.

Run the focused Gemini credential boundary tests:

```bash
node --test tests/integration/liveTokenRoute.test.js tests/unit/liveTokenSecurity.test.js tests/unit/geminiCredentialHttpApi.test.js
```

These tests verify request-scoped key handling, Viewer rejection, expired JWT
rejection, logout cleanup, `no-store` responses, and that keys do not enter
persistent storage or logs. The legacy profile credential test is retained
only while its removal is being completed and must not be used as Live flow
evidence.

Run the Gemini Live normalized Cue flow integration test:

```bash
node --test tests/integration/liveSubtitleCue.integration.test.js
```

Run Cue persistence and checkpoint identity tests:

```bash
node --test tests/unit/subtitleCuePersistence.test.js
```

This test uses `LiveTranslateSession` with deterministic clock and provider
message mocks to cover partial pairing, boundary events, Stop flush, segment
sequence continuity, and replay de-duplication. Cue persistence uses the
existing Segment checkpoint file and is covered by the Cue persistence tests.

Run Session sharing unit and integration tests:

```bash
node --test tests/unit/sessionShareService.test.js tests/unit/fileSessionShareService.test.js tests/integration/sessionSharing.integration.test.js
```

These tests cover opaque token expiry and revocation, file-backed token
persistence, Viewer-safe payloads, per-Session SSE isolation, monotonic event
IDs, terminal snapshots, and reconnecting to the latest snapshot.

Current integration coverage:

- The live Cue integration path continues to validate normalized partial/final
  Cue state; UI-level Cue rendering uses deterministic test-mode events.

- Successful `POST /api/live-token`
- Invalid language
- Missing request-scoped `geminiApiKey`
- Provider expired-token style failure
- Structured error response for invalid JSON
- Demo access-token gate
- Origin allowlist enforcement
- IP-based rate limiting
- Security headers and request id response headers
- `/healthz` and `/readyz`
- Meeting checkpoint API persistence, Segment recovery, Meeting detail read
  reconstruction, and accelerated 2+ hour Long Meeting reload validation

## E2E Tests

E2E tests use Playwright and a Vite test config that aliases `@google/genai` to a
browser mock.

Install Playwright if it is not already installed:

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
```

Run E2E tests:

```bash
npm run test:e2e
```

Run the Live Translate E2E flow only:

```bash
npx playwright test --config tests/e2e/playwright.config.js tests/e2e/liveTranslate.spec.js
```

Run the Session sharing Viewer E2E flow only:

```bash
npx playwright test --config tests/e2e/playwright.config.js tests/e2e/sessionSharing.spec.js
```

This flow verifies read-only Viewer rendering, cross-Session content isolation,
and recoverable invalid or expired share-link errors through the independent
`#viewer?code=<shortCode>` route.

The Playwright flow:

- Live Cue rows keep source and translation paired, show session-relative
  timecodes, keep one partial row at the list tail, protect manual scroll
  position, and restore persisted final Cues on session detail reload.
- Stable Cue UI contract selectors include `live-cue-panel`, `cue-list`,
  `cue-final-row`, `cue-partial-row`, `cue-source-text`,
  `cue-translated-text`, `cue-timecode`, and `follow-latest-button`.
- Legacy transcript assertions are retained only for the no-Cue fallback
  fixture; Sessions with Cues are verified through the final Cue list and do
  not require the removed article tabs.
- The Playwright suite includes the manual-scroll follow-latest regression case;
  run the targeted spec after changing live Cue behavior.

- Opens the home page
- Selects a target language
- Clicks `Start`
- Mocks microphone permission and media tracks
- Verifies the UI reaches `Listening`
- Clicks `Stop`
- Verifies the mocked session closes and microphone tracks stop
- Mocks an unexpected close and verifies controlled reconnect for that reason
- Verifies token expiration triggers controlled reconnect with a fresh token and
  Segment recovery checkpoint
- Verifies browser-suspended wake recovery triggers controlled reconnect with a
  fresh token and Segment recovery checkpoint
- Verifies `#live?meetingId=...` reload restores checkpointed transcript content
  and manual resume continues in the next recovered Segment
- Verifies authorization failure and rate-limit UX messages do not trigger
  reconnect
- Verifies manual recovery states keep Start available, hide Stop, preserve
  transcript/export state, and reset transcript on manual Start
- Verifies reconnect failure, retry exhaustion, Stop cancellation, and
  transcript preservation during recovery errors
- Verifies long-meeting Stop resource diagnostics for mocked mic tracks,
  AudioContexts, Live sessions, and cancelled rollover scheduling
- Verifies read-only finalized session history list behavior for empty state,
  stopped sessions, failed sessions, manual restart, token-expiration reconnect,
  and reconnect without duplicate history records
- Verifies read-only inline session detail behavior for saved metadata,
  final-only source and translation transcripts, close behavior, failure
  reasons, and no-transcript empty state
- Verifies saved session detail export controls for TXT/SRT/VTT availability,
  unsupported stream combinations, session switching, and active export state
  separation

## Live Smoke Test

The live smoke test is the only test path allowed to call the real Gemini API.
The direct shell entrypoint requires `GEMINI_API_KEY` and enables the real API
call automatically.

The backend uses `v1beta` when provisioning an ephemeral token. The browser and
smoke-test Live clients use `v1alpha` because the current `@google/genai` SDK
requires `v1alpha` for ephemeral-token connections. The SDK may still print its
experimental ephemeral-token warning; that warning is expected.

Direct two-hour run:

```bash
./scripts/live-meeting-smoke.sh
```

Equivalent npm command:

```bash
npm run test:live-smoke
```

For a safe no-op check that never calls Gemini, run the Node implementation
directly without `ENABLE_REAL_GEMINI_TEST=true`:

```bash
node scripts/live-smoke-test.js
```

Optional environment variables:

- `LIVE_SMOKE_TARGET_LANGUAGE`: target language code, defaults to `en`
- `LIVE_SMOKE_TIMEOUT_MS`: connection timeout in milliseconds, defaults to `15000`
- `LIVE_SMOKE_DURATION_MS`: run duration, defaults to 2 hours (`7200000`)
- `LIVE_SMOKE_MAX_TOKEN_REQUESTS`: maximum token requests, defaults to `20`
- `LIVE_SMOKE_SPEECH_TEXT`: macOS `say` input text
- `LIVE_SMOKE_SPEECH_INTERVAL_MS`: interval between generated speech samples,
  defaults to `10000`
- `LIVE_SMOKE_REQUIRE_RECONNECT`: require at least one provider reconnect;
  defaults to true for runs of 10 minutes or longer and false for shorter runs

The long-meeting smoke test requires macOS `/usr/bin/say` and
`/usr/bin/afconvert`. It generates a short source-language speech sample,
converts it to mono 16-bit PCM at 16kHz, and loops it through Gemini Live for
the configured duration. Each generated speech sample ends with an explicit
`audioStreamEnd` signal so final input transcription does not depend only on
provider voice-activity detection. Provider reconnects reuse the
session-resumption handle; token refresh is counted and must stay within the
configured limit. Short diagnostic runs do not require a provider reconnect;
the default two-hour run does.
GoAway is an expected provider WebSocket lifecycle event; the test reports its
count separately from reconnect failures. The test prints only non-sensitive counters and is not intended for CI.
During execution it prints startup stages, provider connection/reconnect events,
speech sample sends, and a non-sensitive heartbeat every 60 seconds. The
default run lasts two hours; use `LIVE_SMOKE_DURATION_MS` for a shorter manual
check. At the end of every run it prints a Chinese summary with the start time,
end time, actual duration, provider connection/reconnect counts, token requests,
GoAway count, final transcript count, and sanitized abnormal events. The JSON
summary that follows keeps English field names for machine processing.

Two-hour validation:

```bash
./scripts/live-meeting-smoke.sh
```

CI must not set `ENABLE_REAL_GEMINI_TEST=true` unless the job is explicitly
intended to spend real Gemini API quota.

### Subtitle Cue export (WP5A)

Server export tests should use persisted Final Cues as the primary fixture.
Verify TXT, SRT, and VTT content from the same sequence-sorted Cue list,
including partial filtering, duplicate timeline validation, source-hash
idempotency, artifact retry, and signed URL readiness. P8 UI tests must also
verify that Supabase cloud mode uses the asynchronous export panel while local
mode shows the unavailable message and never creates a browser transcript
download. Do not use DOM layout or Cue UI line wrapping as export input.
# Recorder sharing validation

Use mocked request contexts to verify Recorder share role migration, lease
claim/heartbeat/release, duplicate claim (`409 recorder_already_active`),
expiry, hash-only grant expiry/revocation, Recorder live-token authorization,
snapshot/audio write authorization, and fence-token rejection. Do not call
Gemini or run a full benchmark.
## Issue #35 Phase 1–2 checks

Run the focused boundary checks before broader API tests:

```bash
node --test \
  tests/unit/cloudEnvironment.test.js \
  tests/unit/supabaseRestClient.test.js \
  tests/unit/accessToken.test.js \
  tests/unit/supabaseRepositoryOwnership.test.js \
  tests/unit/deploymentPreflight.test.js
```

These tests assert safe environment diagnostics, user JWT versus service-role headers, expiring-session refresh, and owner-scope repository behavior. Cloud smoke still requires a fresh Supabase access token and must not print it.

Readiness coverage also verifies the core persistence tables, translation metric/queue RPCs, and private `meeting-audio` Storage bucket through the service-role client. Run the local migration checks before relying on readiness results:

```bash
supabase db lint
supabase migration up --include-all
```

The production API must fail closed with `503 cloud_capability_unavailable` when the server-side Supabase contract is invalid; this guard is separate from browser-safe client configuration and must not be bypassed by file-backed fallback repositories.
P7 cloud export lifecycle coverage, without Gemini or production Storage:

```bash
node --test tests/unit/exportArtifactService.test.js tests/unit/exportWorker.test.js tests/unit/meetingExportSource.test.js tests/unit/workerEndpoint.test.js
```

Migration validation must include the private `meeting-exports` bucket,
owner-only Storage policies, `export_artifacts` constraints, and `export_jobs`:

```bash
npm run db:lint
```

Issue #37 Phase 4 retention, compatibility, and observability checks:

```bash
node --test \
  tests/unit/meetingRetention.test.js \
  tests/unit/meetingContentExpiry.test.js \
  tests/unit/supabaseLegacyWriteCompatibility.test.js \
  tests/unit/meetingPurgeWorker.test.js \
  tests/unit/supabaseMeetingAudioService.test.js \
  tests/unit/meetingReadQueryService.test.js \
  tests/unit/observability.test.js
```

These tests verify the 30-minute deadline read model, stable `410` expiry
contract, v1 read compatibility with v2 legacy-column write suppression, and
best-effort purge metrics. They do not call Gemini or remote Supabase.

## Mobile diagnostic export

Focused deterministic coverage:

```bash
node --test tests/unit/livePipelineTrace.test.js tests/unit/clientDiagnostics.test.js tests/unit/webrtcSubtitleTransport.test.js tests/unit/viewerLongSessionRecovery.test.js
npx playwright test --config tests/e2e/playwright.config.js tests/e2e/liveTranslate.spec.js -g "diagnostic export|viewer diagnostics"
```

The unit tests verify ring-buffer bounds, schema/version fields, timestamp/Meeting/generation/negotiation correlation, allowlist filtering, Web Share and Blob download paths, visibility lifecycle events, and sensitive-value exclusion. Playwright verifies that Recorder export does not stop an active session, Paused Recorder and Viewer can still export, export failure remains isolated, and the control fits a 412×915 viewport in Chromium and mobile WebKit. Native iPhone Safari and Android Chrome share-sheet/file-save behavior remains a real-device Preview acceptance item.

## Local raw translation comparison

Use only a local development build, or a diagnostic test build explicitly compiled with `LIVE_TRANSLATE_DIAGNOSTICS=true`. In browser DevTools:

```js
window.__liveTranslateDebug.enableTranslationComparison()
window.__liveTranslateDebug.getTranslationComparisons()
const json = window.__liveTranslateDebug.exportTranslationComparisons()
copy(json)
window.__liveTranslateDebug.clearTranslationComparisons()
window.__liveTranslateDebug.disableTranslationComparison()
```

Reloading also clears the in-memory records. Use a non-Production meeting, synthetic speech, and an explicitly authorized test Gemini key. Never use Production meetings, Production keys, sensitive recordings, or real confidential subtitles.

The controlled manual matrix must cover: (1) repeated words, `你好你好你好。`; (2) numbers, `車子 123。`; (3) the long sentence `現在正在進行會議測試，請確認每一句翻譯是否完整。`; (4) at least 30 seconds of continuous speech; (5) pause then continue; (6) glossary enabled and disabled; and (7) partial plus late-final revision.

For each event, inspect identity fields, provider raw/normalized/glossary-corrected/canonical text, source and translation versions, final/late-final status, authoritative snapshot application, and revision analysis. Source coverage remains `unverified` unless independent alignment evidence exists; neither the longer nor shorter translation is automatically correct.

## Spoken turn trace and real-microphone acceptance

Automated coverage must use the mock Gemini adapter. For a local or Vercel
Preview runtime, set server-only `LIVE_PIPELINE_TRACE_ENABLED=true`, redeploy or
restart, then inspect a turn with:

```js
const trace = window.__liveTranslateDebug.getPipelineTrace()
window.__liveTranslateDebug.getTurnTrace(trace.at(-1)?.audioTurnId)
const exportedTrace = window.__liveTranslateDebug.exportPipelineTrace()
copy(exportedTrace)
```

For a WebRTC recovery investigation, run the export separately on the Recorder
and Viewer from the same Meeting after `recovery_failed` and before either page
reloads. Save both JSON values. Correlate `meetingId`,
`participantId`/`viewerId`, `transportGeneration`, `negotiationId`,
`signalSequence`, signaling cursors, and timestamps. The trace deliberately
records no SDP, ICE candidate body, credential, token, transcript text, or
audio.

Local terminal replay entries include bounded `originEventId`,
`terminalStatus`, `terminalReason`, `localFinalize`, and
`isTerminalReplay` fields. Use these fields to distinguish a local-silence
flush from a new provider transcript; they never contain API keys, tokens, or
audio.

The endpoint exposes only `{ livePipelineTraceEnabled: true }`; the trace stays
in browser memory and resets on reload. Every entry has a bounded
`traceSequence`; normalized and Cue transitions keep their provider
`eventSequence`; Cue updates include bounded before/after source and translation
text. `exportPipelineTrace()` returns the same bounded, secret-free entries as
formatted JSON for saving from Preview DevTools. For each spoken turn, verify the trace
reaches `PCM_CAPTURED`, `PCM_SENT`,
`PROVIDER_EVENT`, `TRANSCRIPT_NORMALIZED`, `TURN_ASSIGNED`, one of `CUE_CREATED`
or `CUE_UPDATED`, and `REACT_RENDER`. Speech activity emits
`SPEECH_ACTIVITY_STARTED` and `SPEECH_ACTIVITY_CONTINUED`; local silence emits
`LOCAL_SILENCE_DETECTED` with non-empty `audioTurnId`; correlate later
`TURN_ASSIGNED` and Cue stages by that same `audioTurnId`; reconnect and segment replacement emit lifecycle stages.
A `drop` entry must include `dropReason`. Also inspect the subtitle DOM for missing or duplicate
Cue rows and the browser console for runtime errors.

Real browser and real microphone acceptance remains manual and must cover:

1. One sentence and two consecutive sentences (two separate Cues).
2. Five rapid sentences and sentences separated by 2–3 seconds.
3. One continuous 20–30 second sentence with partial updates and one final Cue.
4. Pause/resume followed immediately by speech.
5. Provider reconnect/rollover followed immediately by speech.

Mocks, unit tests, Playwright, and DOM inspection cannot mark these real-device
cases as passing. Each case passes only after the spoken text is confirmed
through PCM, provider, normalized transcript, Cue state, React render, and the
visible subtitle.
# Recording retention and completed Meeting deletion

Current policy (2026-10-07): expiry is an authorization boundary only. Targeted
tests must verify ordinary-user hiding, Viewer `410 meeting_content_expired`,
active `super_admin` pending-delete visibility, and explicit canonical deletion.
Legacy cleanup-worker tests cover dormant compatibility code; no GET or timer
may invoke that worker.

Run focused tests with `node --test tests/unit/localMeetingRetention.test.js tests/unit/supabaseMeetingCleanupWorker.test.js tests/unit/meetingDeletionService.test.js tests/unit/meetingDeletionHttpApi.test.js tests/unit/meetingReadQueryService.test.js`.
With local Supabase running and migrations applied, execute
`psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 -f tests/integration/recording_retention_local.sql`
and the equivalent `meeting_deletion_local.sql`. Both fixtures roll back;
they do not call Production, wait 30 minutes, or invoke Gemini. The SQL test
checks direct RLS/Storage visibility, immutable deadlines, late writes,
authorization, persisted cleanup throttling, and bounded continuation.
Browser UI regression: `playwright test tests/e2e/meetingManagementDelete.spec.js --config tests/e2e/playwright.config.js`.
