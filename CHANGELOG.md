# Changelog

## Unreleased
- 正式錄音與 Viewer 流程已接入 WebRTC DataChannel：Device 使用登入 JWT 與既有 canRecord 規則，Viewer 沿用 code/token 分享連結，自動處理 snapshot、cue append/update、replay、去重、重連與安全狀態；Realtime/SSE 仍是依賴雲端 cue 寫入的 fallback。
- Phase 0 contract documentation now fixes the browser/local-service boundary:
  immutable OPFS chunks are explicitly sent by the browser and the service
  cannot read page OPFS. Cue, checkpoint, operation, and audio delivery each
  use a browser durable pending queue with explicit ACK, resend, conflict, and
  recovery ordering. Viewer sharing is separate from host export permission;
  Viewer/Recorder shares stop immediately while host export/audio download
  remains available for 30 minutes. Deployed Origin/CORS is Preview/Production
  allowlist-only, and failed or environment-blocked tests cannot be reported
  as a passing baseline. Phase 1 real-device acceptance remains pending.
- Cue 的原文與翻譯現在分別追蹤完成狀態；任一側穩定後即可發布至 Viewer，延遲抵達的另一側會更新同一 `cueId`。source-only／translation-only Cue 可保存與 replay，DEV 模式並加入 Live-to-Viewer latency timestamps。
- 修正 Viewer 在 Realtime replay 時把 SSE `: keep-alive` 心跳當成 JSON 解析、錄製一段時間後顯示錯誤的問題；replay 現在明確要求 JSON，且保留 EventSource 的 SSE fallback。
- 會議設定的觀看連結現在會以新分頁開啟，公開 Viewer 路由也不再要求 Workspace 登入。
- 修正即時錄製開始後頂部會議狀態仍顯示「已暫停」的問題，並在暫停完成前等待翻譯字幕儲存，重新進入後仍保留原文與翻譯。
- Viewer header 現在只保留即時字幕標題與會議名稱，不再顯示 Gemini Key、管理入口或帳號選單。
- 修正已登入使用者開啟 Viewer 時，共用 Supabase client 會覆寫短效 Viewer Realtime token，導致即時字幕頻道無法訂閱的問題；Viewer 現在使用獨立的 Realtime client。
- 修正全域字典新增詞條時只保存第一個目標語言翻譯的問題；多語言翻譯現在會完整保存，新增語言也會自動選擇尚未使用的語言。新增與編輯彈窗同步改為分區表單、獨立翻譯管理卡片、行內驗證與固定操作列。
- 修正公開 Viewer share 解析錯誤要求登入者 Supabase client，導致 Viewer detail 與 telemetry 回傳 503 的問題。
- 強化全域字典批次操作的按鈕辨識度，並新增具確認提示的批次刪除功能。
- 移除會議管理與即時錄製提示卡內的 Gemini API Key 輸入框，統一由頁首的 Gemini Key 設定頁輸入。

- Clarified GSK-04: Live token issuance uses only recorder request-scoped keys;
  legacy profile credential storage is removed from the current flow, with
  isolated `GEMINI_API_KEY` use retained only for non-Live workers.

- Fixed cloud Meeting creation failing with HTTP 503 after retention columns were added to the Supabase schema.

## 2026-09-23

- Added Issue #37 Phase 1 Meeting lifecycle v2: Supabase-transactional lifecycle
  commands, Meeting-scoped recorder lease/fence tokens, idempotent operations,
  stable Session identity, Segment ownership constraints, crash takeover, and
  v1 compatibility.
- Hardened Issue #37 Phase 1 lifecycle v2: the CRON worker now expires a
  Meeting after 15 minutes without a persisted heartbeat, revokes its Recorder
  and Viewer access, and schedules a 30-minute retention claim. Terminal
  Meetings reject new writes; v2 finalized transcript data stays in
  `subtitle_cues`; fenced audio uploads may complete or fail only before the
  purge deadline. This adds a future purge-worker claim contract, not physical
  data deletion.
- Implemented Issue #37 Phase 3 retention cleanup: the bounded CRON worker now
  claims due v2 Meetings, deletes private audio/export Storage objects before
  the Meeting database cascade, and marks partial failures retryable. The
  worker reports bounded purge counts without exposing Storage paths or secrets.
- Implemented Issue #37 Phase 4 retention closeout: owner read models now expose
  the purge deadline, expired content returns stable `410` responses, purge
  metrics are recorded with retention labels, and lifecycle v2 writes stop
  populating legacy transcript/segment linkage columns while preserving v1 reads.

## 2026-09-22

- 修正長會議 rollover 與 provider reconnect 同時操作同一 Segment 時的 recovery race；同一段落現在只允許一個 transition，避免重複 `/recover` 回傳 409 並誤顯示即時翻譯失敗。
- 修正錄音期間 Session detail 與 translation history 同時遇到雲端 503 時仍每兩秒輪詢的問題；保留畫面字幕與錄音，並補上安全的 request ID 與 Supabase 診斷記錄。
- 修正錄音啟動在 Segment API 失敗時，因未建立 session 的清理流程再次讀取 `.catch` 而遮蔽原始錯誤的問題。
- Session snapshot 遇到雲端 503 時停止背景重試與重複 UI 錯誤，保留錄音與畫面上的逐字稿；明確 retry 仍可重新同步。
- Recovery reset 不再無條件清除仍可能進行中的 single-flight 狀態，避免同一 Segment 重複送出 recover。
- 修正 live recording recovery race，同一 Meeting Segment 的 recover/finalize 現在使用 single-flight，避免 provider error 與 connection failure 重複送出 `/recover`。
- Live startup debug snapshot 新增 mic、capture、token、provider setup、first PCM、server event、source transcript 與 subtitle cue timing milestones；session record snapshot 不再阻塞首個 PCM。
- 修正即時字幕同一語音輪次的累積片段與數字尾段被覆蓋；Session read / translation API 503 改為安全記錄狀態與錯誤碼並停止無限輪詢。

- Live recording startup now reports origin, authentication, and Gemini credential failures separately; local development prefers `dev_frontend_origin`, microphone recording emits bounded timeslice chunks, and long-meeting segment rollover rotates to a unique Live session ID with a fresh ephemeral token.

- Issue #35 closeout: added Node 22/24 long-meeting soak CI coverage, authenticated staging browser reload coverage, safe Meeting request diagnostics, and deployment/storage evidence guidance.

- Issue #35 Supabase-first closeout: authenticated repositories now preserve the actor JWT across owner/member resource scopes, fail closed when the user client is unavailable, add atomic cloud Meeting plus initial Segment creation, complete member read-only RLS policies, owner-only export/audio guards, recording-permission audit events, and log redaction coverage. Local data migration remains out of scope.

- P8 cloud-only transcript export: Meeting and legacy Session UI no longer
  generate browser TXT/SRT/VTT files. Supabase cloud mode remains on the P7
  asynchronous export lifecycle; local mode shows an unavailable message.

- Issue #35 Phase 1/3 groundwork: readiness now probes core Supabase tables, metric/queue RPCs, and the private audio Storage bucket; production API requests fail closed when the cloud contract is invalid; added member recording RLS policies and supporting indexes.
- 修正 Meeting Settings 捲到底時仍停留在第五步的問題，現在會切換到最後一個設定項目。
- 修正 Meeting Settings 捲動到「錄製權限」卡片時，第六步「成員與錄製權限」未維持 active 的問題。
- Issue #35 Phase 1–2 groundwork: readiness validates Supabase project alignment, owner CRUD can use an authenticated user-scoped Supabase client, service-role access is explicitly named, and expiring browser sessions refresh before private API requests.
- Meeting Settings edit-load diagnostics now preserve HTTP status, structured error code, request ID, and safe actor/resource context; the UI distinguishes authentication, permission, missing-meeting, and cloud-service failures while glossary loading remains independent.
- Active Meeting members can edit ordinary Meeting settings and create or view Viewer shares; destructive management actions remain owner-scoped.
- 即時會議開始錄音前會檢查登入帳號是否已設定 Gemini API Key；未設定時直接顯示設定入口，不啟動麥克風或錄音流程。
- Account management now keeps the current signed-in account status visible and audit logs include application-level login outcomes for active, pending, and disabled profiles.
- Staging validation now uses local Supabase, the local backend, and local E2E checks; manual cloud validation retains only the production read-only preflight and no longer requires staging secrets.
- 整理 CI workflow：PR 與 main 執行 deterministic checks、Supabase local migration validation，並對 Vercel Preview 執行 deployment preflight；保留手動 cloud validation 與排程 translation worker。
- Issue #33 follow-up: active `super_admin` recording authorization is consistent across authenticated meeting paths, and account disable E2E coverage now deterministically verifies confirmation, asset transfer, reload, and disabled state.

- Improved Meeting Settings discoverability for member recording authorization with a dedicated `成員與錄製權限` step and empty-state guidance.

- Issue #33: Google Workspace domain matching is the first gate; new users are pending `member` profiles until an active `super_admin` approves them. Pending users can only read `GET /api/profile`, wait, sign out, or switch accounts. Existing active/disabled accounts and status management are preserved.
- Added Google Workspace account approval flow: new domain users remain pending until a super_admin approves them.

- Adjusted account management to rely on Google Workspace OAuth provisioning; removed password-based account creation.

- Added manual cloud validation workflow with authenticated staging smoke and read-only production preflight.

## 2026-09-16

- 將管理員稽核紀錄從帳號管理頁拆分為獨立的 `#audit` 頁面；保留原有搜尋、篩選、分頁與錯誤重試功能。

## 2026-09-15
- Hardened account audit UUID searches to use exact ID filters and added an explicit audit-load error/retry state.
- Added HTTP coverage for owner-scoped member recording permission changes; local member DTOs now expose `canRecord` normally.

## 2026-09-15
- Account management now uses server-side pagination, email/role search, status filtering, exact global counts, and complete active transfer targets.

## 2026-09-14

- Completed Issue #33 owner-scope propagation for session, translation execution, DLQ, and durable queue requests; actor and resource owner identities remain separate.

## 2026-09-14
- Wired the shared meeting membership authorization boundary into request composition, including resource-owner repository scope and audit REST failure detection.

- Completed Issue #33 follow-up authorization hardening for member recording, meeting membership, admin operations, and disabled profiles.
- Added strict safe audit action filtering and atomic owner transfer coverage. Gemini credentials are excluded from transfer.
- Account management UI now reports loading, success, stable error codes, request IDs, and reloads users after changes.

## 2026-09-11

- 修正部署環境建立會議後 Viewer 分享連結回傳 404 時只顯示泛用錯誤的問題；前端現在提供可辨識的 API 部署提示，並補上 Meeting Settings 實際使用的可重用分享路徑回歸測試。
- Completed P1-B observability closeout: atomic operation-labelled metric buckets, 30-day cleanup isolation, queue/recovery/token/provider/Viewer telemetry wiring, and readiness-safe failure handling.

## 2026-09-11

- Added atomic Supabase translation queue claim, renewal, acknowledgement, and
  expired-lease recovery RPCs with fence-token ownership checks.
- Added a P0 GitHub Actions validation gate for syntax, frontend builds,
  security/cloud boundaries, durable worker behavior, Viewer realtime, and
  Supabase migration linting.
- Corrected the documented browser Supabase key name and expanded the runtime
  environment template and Production smoke-test instructions.

- Default local runtime Meeting and Segment IDs now use UUIDs, aligning file-backed development records with the Supabase checkpoint contract.
- Restored the access-control integration test and documented the local/cloud runtime capability boundary and deployment smoke checks.

- Local runtime persistence now uses Supabase for glossary, durable translation
  queue, dead-letter records, recorder leases, and application metadata. JSON
  files under `data/` remain test/migration fixtures only.

## Unreleased
- Issue #37 Phase 2 Viewer reads now return a bounded latest-100 Cue snapshot with opaque backward pagination, use a joined Supabase query instead of Segment-by-Segment hydration, and let public Viewers load older Cues without duplicates.
- 修正 Supabase Session 寫入 PostgreSQL timestamp 時，將 JavaScript 毫秒 timestamp 正規化為 ISO 8601，並在 `session_create` log 補上底層 Supabase HTTP status。

- Issue #33 follow-up: added member recording authorization, super-admin account management with atomic asset transfer, server-only audit log filtering, and Meeting Settings/account management UI. Viewer share IDs remain stable during transfer and Gemini credentials are excluded.

- 修正 Meeting checkpoint HTTP 400 僅顯示泛用錯誤的問題；前端現在依安全的錯誤 code 顯示中文訊息與 Request ID，並在 checkpoint 邊界補齊 finalized Cue 必要欄位。

- 修正 Supabase checkpoint 讀取既有 Cue 時的 hydration：offset 轉回毫秒數字，並補回語言欄位與 transcription mode；Cue offset 寫入改用 bigint 毫秒值。

- 修正續錄 checkpoint GET contract：明確使用無 body 的 GET、補上 request diagnostics，並讓無 checkpoint 與 UUID validation failure 可被明確辨識。

- 修正 Gemini API Key 未設定時開始錄製只顯示泛用錯誤的問題，改為提供設定 Gemini Key 的入口。

- 修正 Supabase 會議建立的 PostgreSQL timestamp 格式，並補齊全域字典的建立與更新時間欄位。

- 修正首次進入會議設定時共用字典 503 會阻擋整個頁面的問題；字典暫時不可用時仍可建立會議。

- 修正會議清單與全域字典分開載入，空的會議清單會正確顯示空狀態；字典載入失敗不再阻擋會議頁面。

- 修正會議建立與列表載入錯誤被誤顯示成空列表或「無法儲存會議設定」的問題，現在會保留後端錯誤識別碼並提供重新載入。

- 登入頁右側產品展示區改用中亮板岩藍，字幕預覽卡保留深板岩藍層次，降低整體視覺重量。

- 登入頁 Panjaya 雙欄版型改用板岩藍配色，維持既有 Google OAuth 與其他產品頁面的藍綠色系。

- 登入頁改為 Panjaya 雙欄版型：保留 Workspace Google OAuth，新增即時雙語字幕產品預覽、官方 Google 登入按鈕樣式與手機版響應式布局。

- Issue #31 P3：瀏覽器以 TUS 將每段原始 WebM/Opus 直接上傳 private Supabase Storage，後端只處理 owner-scoped metadata、完成驗證與 60 秒下載 URL，避開 Vercel request body 限制；Meeting 刪除同步清理 Storage artifacts。
- Issue #31 P3：Final Cue 先寫入 `subtitle_cues`，再由資料庫 trigger 發送 private Supabase Realtime `cue.append`；Viewer 使用五分鐘 share-scoped JWT、subscribe-first snapshot merge 與自動重連，production 不再依賴 process-local Meeting SSE 狀態。
- Issue #31 P2 first milestone「安全可開會」：新增 Supabase Vault 個人 Gemini API Key 設定與 owner-scoped cloud repositories；`/api/live-token` 依登入者解密個人 Key，完整 Key 不回傳、不寫入 log。

- Issue #31 P1 identity foundation：加入 Supabase Google PKCE 登入、Workspace domain
  allowlist、JWT validation、Profile API、profile header/logout，以及 profiles 與私人
  domain tables 的 owner-scoped composite foreign keys、RLS 與 grants；P1 owner-scoped
  adapters now support the configured cloud capabilities and remain fail-closed when
  Supabase configuration or readiness checks are unavailable。

- Issue #31 P0 deployment foundation：request handler 改為 lazy composition，新增 Vercel
  cloud Function 與 Supabase migration baseline；Vercel cloud shell 不啟動 file-backed
  persistence、WebSocket 或 translation worker，現有本機 Node 與 Gemini Live 流程維持不變。

- 收斂 Meeting Viewer 即時字幕畫面：移除時間與欄位標題，字幕列改為依內容自動高度，新增桌面與手機皆並排的原文顯示切換與回到最新字幕控制，並在桌面雙語欄位間加入分隔線；保留 SSE 與字幕排序／重連行為。

- Live 即時字幕新增「顯示原文」切換，預設顯示原文，關閉後翻譯欄改為單欄；保留新字幕自動跟隨與回到最新字幕行為。

- 精簡即時字幕頁的會議控制列，將裝置與詳細保存資訊改為可收合狀態區，並新增手動專注模式；專注模式只隱藏頁面 Header，錄音控制與重要錯誤仍保持可見。

- 修正會議錄製固定使用 source-only transcription 導致翻譯字幕停留在「翻譯處理中…」的問題；現在恢復使用 `LiveTranslateSession`，由 Gemini Live 直接回傳來源與翻譯字幕，並避免即時 Cue 重複送入非同步翻譯 queue。

- 修正 Live 語音的累積式辨識快照在 boundary 或 turn identity 變動時被重複建立為多個 Cue；現在會維持同一個 local audio turn，對 prefix 延伸更新既有 Cue，並在開發環境記錄 raw／normalized event 與 replace、append、ignore 判定。

- 修正正式錄製在麥克風驗證成功後立即開始時的前端 lifecycle race：Gemini
  `setupComplete` 前不再建立音訊 graph，只有首個 PCM chunk 成功送出後才進入錄製中；
  同時加入 start idempotency、完整 cleanup、stage-specific diagnostics，失敗後可直接重試。

- 修正 AudioWorklet 初始化不相容或 callback stalled 時開始錄製會失敗的問題；現在會自動回退到 ScriptProcessor，只有兩種音訊擷取方式都失敗才顯示錯誤。

- 修正 Live 頁面在會議詳細資料已載入、會議列表仍載入中時，開始錄製被誤判為未選擇會議；並統一裝置摘要字體大小。

- 調整 Live Workspace Header 與 Meeting Control 資訊位置：設定入口移至頁面 Header，麥克風／揚聲器摘要移至中間狀態區。

- Meeting 音訊設定移至設定頁，新增瀏覽器本機 preflight 偏好；Live 頁面改為唯讀顯示裝置，並修正沒有 transcript 的 Meeting 仍可開始錄製。

- 語音管線改用 AudioWorklet capture（舊瀏覽器保留相容 fallback），補上播放錯誤隔離、輸出裝置選擇，以及錄音中的麥克風 stream replacement；切換裝置不會建立新 Session 或清除字幕。

- P1 Flash pipeline 已接回 finalized Cue：每個 Cue 以 `cueId` 建立唯一的
  `gemini-3.5-flash` 初次翻譯 execution，完成後顯示在同一字幕列並觸發
  refinement；翻譯失敗不阻塞 Live transcription，legacy fallback 仍可讀。

- 文件重新規劃即時字幕、初版翻譯與非同步潤飾的四階段 pipeline：interim
  僅供 UI，finalized Cue 成為 persistence、history、export、summary 的穩定來源；
  initial translation 與 refinement 皆附加在同一 `cueId`，失敗不阻塞直播。
- 補充 `gemini-3.5-transcribe-live`、`gemini-3.5-flash` 與可選的
  `gemini-3.5-live-translate-preview` 模型分工、structured output、same-Cue
  version/idempotency/stale-output 規則，以及 lifecycle 資料遺失防護。
- P0 語音優先切片已接入 production runtime：source-only Cue 在 Segment
  recovery、Stop 與 turn boundary 可 finalized 並保存，interim 不進 history/export；
  transcription-only controller 不會觸發舊的 numeric retranslation 或 polishing。
- 修正 GoAway 重連流程：GoAway 視為預期的 provider lifecycle event，使用 `timeLeft`
  只排程一次重連、保留最新 session resumption handle，並為 replacement Live session
  取得新的 single-use ephemeral token；smoke summary 另行統計 GoAway 重連成功與失敗。

- 放寬長會議 smoke test 的預設 token request 上限至 20；保留每次 provider
  reconnect 重新取得 single-use ephemeral token 的行為，避免目前 2 小時測試的
  正常重連次數被錯誤判定為 quota 異常。

- 修正 smoke test provider reconnect 重用已過期 ephemeral token 的問題；每次 GoAway 或
  provider close/error 重連都重新取得 single-use token，並保留可用的 session resumption handle。

- smoke test 結束時新增中文摘要，輸出開始／結束時間、實際耗時、連線與重連次數、Token
  請求、GoAway 與去敏後異常事件；同時保留英文欄位名稱的 JSON 摘要。

- 修正長會議 smoke test 的 provider close/error 診斷與快速重連保護：保留去敏後的
  status／code／message，GoAway 使用 provider delay，異常重連採指數退避與 jitter，連續
  5 次失敗後安全停止，避免短時間建立大量連線或消耗 quota。

- 修正目前 `@google/genai` SDK 的 ephemeral-token 相容性：backend provisioning 維持
  `v1beta`，browser 與 smoke-test Live connection 改用 SDK 要求的 `v1alpha`。

- 修正 `gemini-3.5-transcribe-live` ephemeral-token config；移除 provisioning endpoint
  拒絕的 `languageCodes` 欄位，來源語言提示改由既有 system instruction 保留。

- Gemini Live client 與 ephemeral-token config 統一使用 `v1beta`；長會議 smoke shell
  會自動載入專案 `.env`（不覆蓋既有環境變數），並在 token provider 失敗時輸出已去敏的
  status／code／message 分類診斷。

- 新增可直接執行的 2 小時 Gemini transcription 長會議 smoke test：使用 macOS
  `say`／`afconvert` 產生 PCM 語音，驗證 session resumption、provider reconnect、
  token refresh 上限與 transcript event 去重；shell entrypoint 會要求
  `GEMINI_API_KEY` 後直接執行真實 API 測試。

- 長會議 Segment 預設保存週期調整為 15 分鐘；Gemini transcription provider
  session 會重用 ephemeral token 與 session resumption handle，只有接近過期時
  才刷新 token，Segment rollover 不再新增 token request。

- Live 錄音流程改為使用 `gemini-3.5-transcribe-live` 的來源語言即時轉錄；移除翻譯音訊、翻譯字幕與即時潤飾請求。長會議仍透過 Meeting／Segment checkpoint、切段與續錄保存連續字幕。

- 修正從會議設定前往即時字幕時可能停留在「正在載入會議」的問題；進入 Live 頁會清除舊的會議選取狀態並重新載入指定會議。
- 修正即時字幕載入時呼叫已移除的歷史詳細資料 helper，以及尚未建立錄音 controller 時 cleanup 回傳空值造成的未處理例外；會議資料載入失敗時改顯示可重試錯誤。

- 會議設定的會議詞彙新增 CSV／JSON／XLSX 匯入預覽；匯入結果先加入表單，儲存會議設定後才寫入目前會議，不會修改全域字典。

- 全域字典匯入預覽新增逐列選取；正常列預設勾選，錯誤列可取消後略過，後端仍會阻擋被選取的錯誤資料並維持原子提交。

- 匯入預覽的語言／分類選單統一為 3rem；可直接新增分類，建立後會自動套用並重新產生預覽。

- 新增全域字典單一匯入 Dialog，整合格式說明、檔案選擇與匯入預覽；上傳簡單詞條檔後可選擇來源語言、目標語言與分類。

- 全域字典匯入新增 XLSX 支援；讀取第一個工作表的 `source`／`translation` 欄位，並沿用既有預覽與批次匯入流程。

- 新增全域字典 CSV／JSON／XLSX 匯入：支援後端預覽、逐筆處理重複詞條、完整驗證與原子提交，避免部分匯入造成資料不一致。

- 將共用語言標籤與 Live checkpoint／音訊狀態訊息移至 `lib`／`features/live`，修正前端功能拆分後的遺漏引用，避免 `App.jsx` 與 workspace 元件持有 Live 專用 helper。
- 建立 `useLiveRecordingController` 的固定 Live view-model 介面，讓即時錄製頁透過 controller 讀取狀態並觸發操作，為 audio、transcript/Cue 與 Session recovery 的後續分批搬移保留相容邊界。
- Live audio recorder、原始／翻譯音訊 chunk handler、upload retry binding 與 cleanup 已接到 Live controller 的 audio interface，維持既有 Session lifecycle 與音訊保存流程。
- 移除 `App.jsx` 內重複的 Live audio fallback functions；audio controller 現在由 `src/features/live/useLiveRecordingController.js` 單一管理。
- Live Cue event queue、flush、numeric correction 與 subtitle finalization 已移入 Live controller；Cue persistence、重翻與 polishing callback 仍沿用原有服務邊界。
- Session snapshot 與 Meeting checkpoint sync coordinator 已移入 Live controller；schedule、flush、cancel 與錯誤回報維持既有 API 行為。
- Session recovery controller boundary 已建立；reconnect controller 的建立與取消，以及 reconnect、resume、segment switch actions 現在由 Live controller 提供，既有 lifecycle 實作與 generation guard 保持不變。
- `switchMeetingSegment` rollover lifecycle 已移入 Live controller，包含 checkpoint flush、Segment rollover、舊／新 Live session 切換與 audio resume；既有 generation guard 與狀態轉換保持不變。
- `startReconnectSession` 已移入 Live controller，保留 reconnect generation guard、checkpoint recovery、Live session restart、audio resume、diagnostic 與 failed-session finalize 行為。
- `resumeMeetingSession` 已移入 Live controller，保留 resume draft、Segment recovery/start、Session record、checkpoint、callback generation、control lease 與失敗回復行為。
- 移除 App.jsx 的 `reconnectController()` delegation wrapper，所有 reconnect reset、cancel、connectivity 與 scheduling 操作直接透過 Live controller。
- Segment switch orchestrator 的建立、持有與 cancel/start lifecycle 已移入 Live controller；interval、狀態與錯誤 callback 由 App 注入。
- `startSession` 已移入 Live controller，保留 microphone permission fallback、Meeting checkpoint、Session record、control lease、Live session start、audio recording 與失敗清理行為。
- `pauseSession` 已移入 Live controller，保留 reconnect/segment cancel、audio pause、Session stop、transcript/Cue flush、checkpoint sync 與 paused state transition。
- `continuePausedSession` 已移入 Live controller，保留 paused guard、Live session restart、Cue state preparation、audio resume、snapshot sync 與 segment switch 啟動流程。
- `endCurrentSession` 已移入 Live controller，保留 stop flag、reconnect/segment cancel、audio finalize、terminal Cue drain、checkpoint sync、Session finalize 與返回會議管理流程。
- `completeResumableMeeting` 已移入 Live controller，保留完成前 Cue/checkpoint flush、Meeting complete API、狀態清理與返回會議管理流程。
- 移除 App.jsx 的 Session snapshot、Meeting checkpoint 與 segment switch delegation wrappers，Live 相關呼叫現在直接透過 controller interface。
- `createMeetingCheckpointForSession`、`finalizeCurrentSessionRecord`、`interruptActiveMeeting` 與 failed-session finalize lifecycle 已移入 Live controller，保留 checkpoint、Session record、audio artifact 與 failure recovery 行為。
- `createCurrentSessionRecord` 與初始 transcript snapshot 建立流程已移入 Live controller，保留 Session record、audio download preparation、snapshot sync 與 lifecycle persistence 行為。
- finalized audio artifact upload、retry error handling 與 meeting detail cache refresh 已移入 Live controller，保留既有音訊同步與會議詳細資料更新行為。
- transcript finalization、partial guard、Session snapshot／Meeting checkpoint scheduling 與 final transcript lifecycle persistence 已移入 Live controller。

- Refactored the frontend composition boundary so the authenticated workspace
  shell and Meeting, Glossary, and History UI are exposed through capability
  feature entry points instead of being imported directly from the app shell.

- 新增全域字典分類管理：分類可新增、改名、上下移排序與刪除；刪除分類的詞條會自動改歸「其他」，並相容既有僅含 `entries` 的字典 JSON。

- 全域字典的新增與編輯表單改以置中 Dialog 呈現，保留原有詞條欄位、儲存、刪除與關閉行為。
- 全域字典移除已不使用的歷史重新翻譯範圍設定；Dialog 保留必要捲動但隱藏 scrollbar，並統一下拉選單高度。

- 移除已被目前 Meeting UI 取代的 `#translation-history`、`#watch`、`#record` 與 `#dead-letter-queue` 前端路由；這些舊連結現在回到 `#meetings`。Meeting Settings 僅保留 Viewer 分享入口，翻譯紀錄改由 Meeting 管理與單一會議紀錄頁進入；後端資料與 API 未刪除。

- 將會議 UI 整理為獨立 Setting、History Detail、Live 與 Viewer 頁面；公開 Viewer 的 `#viewer?code=...` 顯示、SSE 即時字幕與重連邏輯已從 `main.jsx` 拆出，分享連結管理保留在 Setting 頁面。

- 建立會議並產生分享卡片後，設定頁會自動捲動到最下方操作列，讓使用者能在畫面中看到分享內容與「儲存變更」按鈕；編輯既有會議不會自動跳轉。

- 修正會議錄音頁靜音後未完成的「辨識中／翻譯中」字幕會永久停留的問題；未完成來源句在有限次翻譯重試後會自動收起，已保存逐字稿不受影響。重載或繼續會議時不再因 3 段暫存上限遺失較早的已保存內容，並補回沒有 final Cue 覆蓋的 checkpoint transcript。

- 修正即時字幕連續說話時的音訊捕捉中斷：短暫恢復後會重設擷取故障計數，並合併高頻 partial 字幕更新，避免長時間錄音因前端負載停止接收後續語音。

- 限制即時字幕事件去重快取為最近 1024 筆，並在 checkpoint 還原時裁切舊事件，避免長時間連續說話造成前端處理與同步資料持續膨脹。

- 修正長會議 checkpoint 發生 409 衝突時直接顯示錯誤的問題；前端會重新讀取最新 checkpoint、去除已保存內容並保留可繼續同步的資料，不中斷目前即時錄音。潤飾中的字幕列改為淡藍色，潤飾完成後移除底色並保留完成標記。

- 修正 Safari 即時錄音啟動流程：在開始操作時立即請求麥克風權限，支援 `webkitAudioContext`，並對未回應的權限提示逾時處理與清理晚到的音訊串流。

- 修正即時字幕麥克風啟動失敗時留在 live 頁提供重試，並清理返回會議管理後的暫態錯誤；會議管理錯誤提示改為內容高度。

- 在即時字幕按下「結束本次工作階段」並完成保存後，會自動返回會議管理首頁。

- 即時字幕 UI 與潤飾流程拆分為 live 專用元件／controller；潤飾完成後立即回寫對應 Cue，僅正在處理的 Cue 顯示底色，並移除字幕列內的潤飾狀態文字。

- 會議匯出區只顯示已成功儲存的原始／翻譯語音下載按鈕；兩者皆不存在時顯示無語音提示，並縮窄字幕下載按鈕、提高格式與內容下拉選單高度。

- 會議紀錄頁的「會議內容」改為獨立的全域字典風格分類卡片，桌面維持兩欄、手機改為上方橫向選單；紀錄、翻譯內容與匯出行為不變。

- 獨立會議記錄頁改為全域字典風格的「紀錄／翻譯內容／匯出」兩欄版型；原文與翻譯改在「翻譯內容」內以 tab 切換，下載與字幕匯出集中於匯出區。

- 已完成會議從會議管理點選「查看翻譯紀錄」時，直接開啟該會議的單一紀錄畫面，不再先進入翻譯紀錄管理頁。
- 會議紀錄頁改用全域字典相同的卡片版型，移除重複的頁內標題與返回操作，保留完整逐字稿、音訊下載與匯出功能。

- 修正即時字幕控制列與 Cue 渲染：移除即時頁設定、字典與匯出功能，並讓隱藏原文時 source JSX 完全不掛載，翻譯欄維持單欄且不混入原文。

- 修正即時字幕說明文字下方的過大留白，讓雙欄標題與字幕內容以 24px 間距自然銜接並增加首屏可讀字幕數量。

- 調整即時字幕標題與句子間距；顯示原文時加入原文／翻譯欄位分隔線，隱藏原文時維持翻譯單欄閱讀。

- 微調即時字幕閱讀層級：錯誤提示貼近工作區，修正狀態改為低調輔助資訊，移除字幕分隔線，並統一原文與翻譯字級、放大欄位標題。

- 改善即時錄製字幕閱讀版型：每段原文與翻譯改為同一列左右並排，縮短字幕上下間距並以文章式分隔呈現；窄螢幕自動改為上下排列，既有字幕資料與錄製流程不變。

- 分享錄音頁已對齊即時字幕的滿版工作區、控制列與字幕閱讀版型，並套用 slate 配色、原文收合、翻譯欄滿寬與最新 Cue 樣式；Recorder 的 lifecycle、音訊同步、Session snapshot、checkpoint 與會議完成流程未變更。

- 精簡即時字幕頁的可見操作：Header 改為「即時字幕」並提供返回會議管理，主畫面僅保留錄音流程控制；設定、字典與匯出入口改由其他頁面承接。

- 建立即時錄製獨立 Page；`#live?meetingId=...` 接管即時錄製畫面，舊的 Meeting Workspace live URL 會相容轉址，Workspace 僅保留其他 Meeting 功能。

- 重做會議即時字幕閱讀版型：移除左側設定卡，改為上方操作列與全寬字幕區；翻譯作為主要閱讀欄，原文可切換顯示並在小螢幕改為上下排列，保留既有字幕與 Session 行為。

- 建立會議的全域字典與私有字典集中至同一個「字典設定」步驟與卡片中；保留原有選取、編輯、刪除與儲存行為。

- 建立／編輯會議頁完整對齊全域字典頁的管理 Header、石板藍色彩 token、表單控制項、按鈕與卡片樣式；移除重複頁內標題並保留既有設定、字典、音訊 Toggle 與分享流程。

- 建立／編輯會議頁改為分區卡片與響應式步驟導引，並將全域字典、音訊設定與私有字典改為更緊湊的操作版面；既有會議建立與分享流程不變。

- 新增獨立 Meeting Settings 頁面與專用 Layout；建立／編輯會議可一次保存語言、字典、翻譯播放與原始音訊設定，建立成功後自動產生永久 Viewer／Recorder 分享連結與 QR Code，分享失敗會保留會議並允許重試。

- 調整全域字典頁沿用會議管理既有背景、卡片、工具列與深青綠色樣式，並統一篩選工具列控制項為 56px 高、10px 圓角與 12px 間距。

- 新增全域字典卡片庫頁面：全域詞條可供所有會議室查看與選擇，私人詞條仍隔離於個別會議；支援分類、搜尋、批次操作、多語言翻譯與右側編輯抽屜。

- 改善會議卡片 RWD：寬桌面支援四欄、一般桌面三欄、小桌面兩欄，1023px 以下切換單欄，維持卡片內容與操作可讀性。

- 改善會議管理首頁滿版版面：移除桌面最大寬度限制，Header 延伸至視窗邊界，並縮短 Header 與會議列表的垂直間距；窄螢幕仍保留安全內距與單欄卡片。

- 調整會議管理首頁標題層級：將頁面標題與副標題整合至全站 Header，移除內容區重複標題，並保留建立／編輯頁返回會議清單操作。

- 改善 #29 會議管理首頁：移除首頁主要 AG Grid 呈現，改為淺色兩欄會議卡片庫；保留搜尋、狀態篩選、全域字典、既有主要操作與 Meeting Workspace 流程，1024px 以下切換單欄並維持卡片鍵盤操作。

- 改善 #29 P2 窄視窗體驗：`1024px` 以下工具列自動換行，Meeting 列表保留安全橫向捲動，避免欄位與操作按鈕擠壓，並維持至少 44px 的操作高度。

- 改善 #29 Meeting 管理列表可讀性：合併語言欄、時間改為分鐘級短格式並保留 tooltip、少量資料隱藏分頁控制，降低表格框線並補強列 hover／focus 與筆電版面。

- 修正 #29 P0 會議管理版面：Header 固定於頁面頂端、移除工具列重複的「建立會議」、列表改為依內容高度呈現，並將草稿刪除移至會議設定的危險操作區。

- 完成 #29 UI 整併收尾：移除五項獨立主導航，`#meetings` 成為唯一首頁；legacy `#live`／`#history`／`#retranslate`／`#glossary` 會導向 Meeting 管理或 Workspace；Meeting 列表改為單一主要操作，Workspace 依狀態顯示分頁，完成會議可撤銷既有 Viewer 分享。

- 完成 #29 Milestone 5：新增獨立 Meeting Cue publish API、process-local SSE broadcaster、cursor replay／gap recovery、Viewer 去重與 refinement merge，以及 deterministic latency SLA 測試；跨程序事件傳遞與 durable replay 仍 deferred。

- 完成 #29 Milestone 4：新增 Meeting Viewer token／短碼／QR 分享、歷史 Final Cue 唯讀快照與 windowed 雙語字幕渲染；即時 Cue 廣播與重連補洞留待 Milestone 5。

- 完成 #29 Milestone 3：新增 Meeting 私有字典，與全域字典在資料、Workspace UI、翻譯套用與 Segment snapshot 中隔離；私有字典不會出現在全域字典或 Viewer payload，既有 `glossaryEntries` 資料維持相容。

- 完成 #29 Milestone 2：新增 status-aware Meeting Workspace，依 Meeting 狀態提供即時字幕、會議字典、分享觀看、匯出與完成後翻譯紀錄分頁；Meeting Management 的繼續錄製與完成會議操作改由 Workspace 承接，既有 `#live`、`#history` 等 legacy 路由保留相容性。

- 完成 #29 Milestone 1：`#meetings` 現在是 Meeting Management 首頁，提供會議名稱／語言／狀態搜尋、狀態篩選、最後更新時間與依 Meeting 狀態顯示的操作；保留既有錄音與設定流程，Viewer 與 Cue 廣播留待後續 Milestone。

- 完成 #29「會議中心 UI 整併與即時字幕直播分享」規格：定義 Meeting 管理首頁、單一 Meeting Workspace、全域／會議專用字典隔離、Meeting-level Viewer 分享、Final Cue 廣播、重連補洞與本地延遲 SLA 驗證；目前已完成 Milestone 1，後續能力仍依交付階段進行。

- 完成 #27 的潤飾 RPM 與長會議可靠性收尾：RPM authoritative gate 現在位於實際 provider attempt 邊界，retry attempt 也會計入；worker 僅負責 durable claim、lease heartbeat、retry/recovery 與 DLQ，rate-limit 等待不再反覆重排 queue item。

- 修正即時翻譯左側設定卡被右側字幕卡強制同高而裁切內容的問題；短視窗現在由頁面自然垂直捲動，設定卡依內容撐高，會議模式與操作按鈕不再重疊。

- 改善整個工作區的筆電版響應式版面；主要標題、說明、欄位與操作文字會正常換行，不再被面板或相鄰元件遮住，低高度視窗也可在設定卡與會議設定卡內捲動。

- 從會議管理前往新的即時翻譯工作區時，會清空上一場的即時字幕、潤飾預覽與音訊暫存；既有歷史紀錄與 Meeting checkpoint 不受影響，續錄仍會重新載入保存內容。

- 修正共享錄音停止後會議仍顯示進行中的問題；停止錄音現在會同步完成目前錄音段落並將 Meeting 標記為已完成。

- 即時翻譯重連失敗現在會將最近 10 次安全診斷摘要保存到 Session 詳情，包含來源、階段、原因與 provider code/status，不保存 token、API key 或原始錯誤內容。

- 修正長時間錄音結束時保存最終翻譯結果可能因完整 source transcript snapshot 超過 10KB 而回傳 413；`/api/translation-outputs` 現在使用獨立的 25MB 請求上限。

- 修正麥克風音訊捕捉鏈：恢復 suspended AudioContext、重建失效 capture graph，並將 PCM 傳送失敗轉為可恢復錯誤。

- 修正潤飾完成後即時字幕仍顯示「等待修正」：success result 現在以 targetCueId 原地更新 active Cue，並以 refinement version 保護 polling 與 checkpoint merge。

- Fixed paused and recovered Meeting continuation so a successful resume clears
  stale session-save errors.
- Marked source Cues complete when restored or completed polishing outputs are
  available, preventing finished Cues from remaining in 「等待修正」.

- 即時字幕匯出統一使用畫面相同的修正版 Final Cue 清單；排除 partial、合併相鄰完全相同字幕，並讓 TXT、SRT、VTT 共用相同 Cue 匯出路徑。

- 會議字幕匯出優先使用已保存的 Final Cue；停止、分段切換與完成會議前會強制同步最後的字幕 Cue，沒有 Final Cue 的舊紀錄則使用保守分組 fallback。

- 完成會議現在為唯讀；設定不可修改，既有分享可查看但不可新增或撤銷。

- 已完成會議不再導向即時翻譯；會議管理與舊的已完成即時連結都會直接開啟翻譯紀錄詳細內容。

- 修正即時字幕過度切碎與逐句修正狀態長期停留「修正中」的問題；短片段會優先合併為自然句，修正版完成後會正確更新，失敗時保留原始翻譯。

- 即時錄製刪除現在會與會議管理同步；刪除任一已完成錄音段落會一併刪除整場會議的所有段落、逐字稿、音檔與錄音分享。會議多段錄音也會依段落順序合併成單一下載音檔。

- 修正錄音結束時仍有非同步即時翻譯流程回報麥克風擷取錯誤的問題；主動結束後會取消過期的啟動、重連與分段切換流程，並維持已停止狀態。

- 修正即時翻譯斷線且重連耗盡後，會議仍停留在「進行中」並無法重新進入的問題；現在會保存 checkpoint、標記為「已中斷」，並可從會議管理續錄。

- 保留完整 OpenCC 初始載入，並將 AG Grid、QR Code 與 Downshift 拆分為獨立 vendor chunks，避免 build 出現 large file warning。

- 調整會議字典抽屜的響應式版面；抽屜內新增詞條後會立即置頂顯示並套用，窄螢幕下的詞條清單與操作區也可正常捲動。

- 修正快速新增詞條時，較晚返回的字典載入結果覆蓋新詞條，導致上方會議字典選單未即時更新的問題。

- 依照左側工作區目錄調整筆電版字典抽屜寬度，讓 761–1200px 螢幕使用 340px 窄抽屜並保留更多上方選單空間。

- 修正首次使用時沒有 `data` 資料夾造成建立資料失敗的問題；伺服器啟動前會自動建立設定的資料目錄。

- 調整 13／14 吋筆電的響應式工作區：保留縮窄側欄，並讓即時翻譯、會議管理、翻譯紀錄與相關面板在有限寬高下可正常捲動。

- 即時翻譯的會議選擇改為可搜尋的 autocomplete，支援鍵盤選取與無結果提示，避免一次展開所有會議選項。
- 即時錄音現在必須先選擇狀態為 `created` 的會議；無效或已失效的會議連結會導回會議管理。
- 即時頁會呈現會議建立時的設定值；會議名稱、語言與會議字典需回會議管理修改。
- 即時頁移除工作階段名稱欄位，會議選擇欄位改名為「選擇會議」。
- 從即時翻譯返回會議管理修改時，會直接開啟目前會議的設定編輯畫面。

- Meeting-first recorder sharing creates the Meeting before recording, issues
  an entry link and QR code, and delays Session creation and microphone access
  until the recipient explicitly starts recording.

- Completed the Recorder persistence path: finalized transcript updates,
  segmented input/translation audio, checkpoint writes, metadata protection,
  Recorder QR/short-code URLs, lease expiry cleanup, and unload release.

- #21 Recorder flow now issues short-lived hash-only grants after lease claim,
  authorizes Recorder live-token, snapshot, and audio writes with lease/fence
  checks, supports heartbeat/stop lifecycle in the Recorder page, and keeps
  Recorder audio downloads restricted.

- Added Viewer/Recorder share capability roles and a file-backed, fenced
  recorder lease API for independent Session recording.

- #21 Session sharing acceptance coverage now verifies read-only Viewer routes,
  Session isolation, terminal snapshots, reconnect behavior, share expiry and
  revocation, and single-tab microphone control.

- Session read-only recovery and control isolation: `#live?sessionId=...` now
  opens a live or completed Session as a read-only view when the current tab
  does not own its microphone control. Browser tabs coordinate a short-lived
  local control lease so a second tab cannot start or take over another active
  Session.

## Unreleased

- #27 finalized Cue refinement now queues one asynchronous request per Cue with
  at most two preceding finalized Cues as context. Only the addressed Cue is
  updated; subtitle resegmentation remains a separate batch capability, and
  transcript polishing provider execution is rate-limited by the configured
  RPM with durable queue deferral.

- 修正逐句潤飾結果的 target identity 與 canonical Cue persistence；polished/refined output 現在依 `cueId` 原地更新，不會因輸出順序覆寫其他 Cue 或在 reload 後退回 pending。

- DEV 模式新增 Live session 端到端事件證據與 `window.__liveTranslateDebug.getSnapshot()`；明確記錄 PCM 產生、SDK send 的 void/sync throw/async reject，以及 input-end outcome。Token config 明確啟用 automatic activity detection，並支援依 provider config 使用 `activityStart/activityEnd`；移除 live transcript 的 3 秒 idle 偽 finalization。E2E 測試 backend 改用獨立 3100 port。

- 修正 Live Translate 首段語音在重連或 Pause → Resume 後卡在「辨識中」的問題；mic ready 與 provider ready 現在分離，只有目前 Gemini Live session ready 後才 attach audio graph 並送 PCM，舊 session 的 audio/transcript callback 會依 connection epoch 丟棄，Pause、reconnect、rollover、Stop 會先執行 protocol-level input flush。

- 修正暫停或重新載入後繼續錄音的啟動空窗；新 Live Session 完成音訊管線與 callback 初始化後才啟用字幕，並重設字幕時間原點與清除舊 partial Cue。

- 修正續錄後字幕 partial Cue 卡住：新 Segment 開始前會完成可配對的舊 Cue、清除無法配對的 recovery partial 與事件 metadata，並讓 source-only retranslation 在有限次數後明確失敗，不再永久等待。

- 修正重新載入會議後繼續錄製沒有新增字幕的問題；續錄現在會同步初始化字幕時間原點，讓新的雙語 Cue 正常顯示。

- 修正續錄時指定麥克風回報 `Invalid constraint` 會中止錄音的問題；現在會安全改用瀏覽器預設麥克風並繼續錄製。

- 修正重啟後續錄遇到 legacy 字典 alias 非陣列資料時的 `Symbol.iterator` 錯誤，現在會安全忽略無效 alias。

- 修正長會議續錄時重複建立既有翻譯 request／execution 導致 HTTP 500 的問題；相同命令現在可安全重試且不會重複啟動已執行的翻譯。

- 修正即時翻譯在暫停或結束前收到的最後一批字幕未更新到畫面的問題；terminal flush 現在會保留並完成顯示最後的雙語 Cue。

- 修正字幕重分段潤飾 worker 未讀取 `items[].rawSource`，導致有效字幕被誤判為空白原文而失敗。

- 即時翻譯會依續錄資料自動顯示單一「繼續錄製」或「開始」按鈕；待續錄會議可選擇「結束會議」封存，既有逐字稿與 checkpoints 會保留。

- #27 finalized Cue refinement now runs asynchronously per Cue, preserves raw
  source/translation values, applies version-fenced refined source and
  translation values to the same Cue row, and supports refined-default or
  explicit raw transcript exports.

- 改善筆電版重新翻譯 Session 清單：隱藏次要結束時間欄、縮窄欄位與操作區，避免重新翻譯按鈕被裁切。

- 改善筆電版翻譯紀錄表格：隱藏次要結束時間欄並縮窄主要欄位，減少水平擁擠；失效會議路由提示也不再跨頁殘留。

- 修正筆電高度不足時即時翻譯設定卡的內容被裁切問題；設定內容現在可獨立捲動，開始／暫停／結束等操作區固定在卡片底部，手機版仍維持頁面自然捲動。

- 空資料狀態保留各主要資料表欄位與分頁框架；沒有可用會議或紀錄時不再顯示誤導性的「開始即時翻譯」按鈕。

- 會議紀錄詳細資料改為獨立畫面，從翻譯紀錄或會議列表進入後可返回原列表，並保留時間軸、逐字稿、閱讀、下載與匯出功能。

- 翻譯紀錄改為會議管理風格：使用工作區側欄、會議導向資料表與會議摘要；沒有 Meeting 的一般 Session 會以「單次翻譯」會議卡呈現，既有查看、匯出、刪除、繼續翻譯與重新翻譯操作維持不變。

- 即時翻譯入口現在只允許使用尚未開始錄音的已建立會議。

- Added guarded Meeting deletion from Meeting Management. Only unstarted
  `created` Meetings can be deleted; their draft Segments and Recorder shares
  are removed together, while started or terminal Meetings are protected.

- Added Meeting Management: creators can configure a Meeting name, languages,
  and glossary before generating a Recorder share link; shared recording only
  activates the Meeting and creates a Session after explicit start.

- 修正主要頁面外框寬度，桌面版改為全寬顯示並保留響應式安全內距。

- 調整全站內容比例與響應式欄位，讓控制項、字幕、紀錄與重新翻譯工作區依畫面寬度流動排列。

- 翻譯紀錄、重新翻譯與翻譯字典的主要列表改用 AG Grid Community，使用內建欄位排序、原生分頁與每頁筆數選擇，既有搜尋、詳細資料與翻譯操作維持不變。

- Added single-host multi-process safety for file-backed translation queue and
  dead-letter queue operations. Sidecar locks serialize claims, enqueue,
  retry, renewal, acknowledgement, and transfer operations; writes use unique
  temporary files and atomic rename with bounded stale-lock recovery.

- Added authenticated per-Session WebSocket execution status snapshots with
  reconnect, REST refetch, and polling fallback behavior.

- Added retry lineage visibility to History detail. Executions sharing the
  same translation request are grouped into a chronological timeline, with
  existing failed-execution retry controls preserved and no API contract or
  queue behavior changes.

- Added a hash-only DLQ management page at `#dead-letter-queue`. It lists the
  complete FIFO queue, safely exposes saved failure metadata, confirms and
  replays one item at a time, retains the original item, and supports refresh
  and recoverable error states without adding navigation or changing queue
  behavior.

- Added authenticated DLQ listing and single-item replay APIs. Replay retains
  the original failed execution and DLQ item and creates a new queued execution.

- Added process-local queue reliability metrics with a protected
  `GET /api/metrics` snapshot. Worker success/skip/cancel/retry/failure,
  recovery, DLQ transfer, lease, acknowledgement, queue depth, and last-success
  state are tracked without exposing execution or provider identifiers; metric
  failures do not affect translation behavior.

- Reliability closeout verified the Phase 3J queue retry and dead-letter path:
  deterministic retry classification, capped backoff scheduling, durable
  retry metadata, lease-owned DLQ transfer, restart recovery, and stale-lease
  fencing are covered by the focused unit and integration test set. Remaining
  reliability work is limited to multi-worker coordination, cross-process
  atomicity, event deduplication, and metrics/observability.

- Connection resilience now pauses reconnect while the browser is offline and
  resumes the same recovery generation after `online`. Microphone track loss
  cleans up before recovery and falls back to the browser default microphone
  when the selected device is unavailable, with deterministic unit and E2E
  coverage.

- Added shared Access Token v1 for private `/api/*` routes. Authenticated HTTP
  and execution-events WebSocket requests now use the Supabase access token.
  Health/readiness and anonymous share Viewer routes
  remain public, while per-user identity and RBAC remain deferred.

- Phase 2B-2 frontend translation history/detail reads now centralize legacy and
  formal output merging, selected-output projections, and polished article
  derivation in a focused helper while preserving existing HTTP payloads and
  history behavior.

- Phase 2B-2 translation history mapping now uses dedicated translation
  read-model wrappers for request, execution, and output DTOs without changing
  existing history/API response shapes or safe failure filtering.

- Phase 2B-2 export foundation now exposes an `ExportApplicationService`
  boundary over the existing transcript and saved-session export helpers;
  live, meeting, retranslation, and saved-session export generation now use
  the boundary while TXT/SRT/VTT output behavior remains unchanged.

- Phase 2B-2 translation foundation now exposes a `TranslationApplicationService`
  boundary for translation commands and history reads. Existing HTTP payloads,
  queue lifecycle, provider resolution, and translation persistence behavior are
  unchanged.

- Phase 2B-2 Session foundation now exposes a `SessionApplicationService` for
  Session create/update/finalize commands and history/detail read models while
  preserving existing HTTP contracts and storage adapters.

- 建立 Session-first 垂直切片：即時翻譯會在 Gemini Live 啟動前先保存 `created` Session，Pause/Resume 會同步 Session 狀態並為逐字稿保留 `sessionId`/`segmentId`；新增 opaque share token、撤銷分享、Viewer-safe detail 與依 Session 隔離的 SSE snapshot stream。

- 改善操作管理者 UI：即時翻譯的錄音與播放設定改用直白命名，所有翻譯工作階段統一顯示在單一翻譯紀錄清單，並補充來源語言、目標語言與表單操作提示，改善手機版操作間距。

- 修正語音潤飾資料流：Flash Lite 只讀取已 finalized 的 Cue snapshot，結果獨立保存為 polished article；不再回寫 Raw Transcript、Live Translation、Cue、Session record 或 Gemini Live prompt。潤飾啟用與停用時送往 Gemini Live 的 PCM chunk 保持一致。

- 即時字幕潤飾會以已 finalized 的雙語 Cue 作為上下文，結果獨立保存為文章版翻譯；Raw Transcript、Live Translation、字幕與匯出內容保持原始結果。

- 修正即時字幕過度依 Gemini turn 切成短列：沒有句末標點的雙語片段可跨 turn 合併；若來源時間或數字在譯文中遺失，會在同一 Live session 觸發一次不重播音訊的校正翻譯，並回填原 Cue。

- 修正 turn boundary 時 pending 原文未被 flush 的漏字風險。

- 修正停止或段落切換時未送出的尾端 PCM，以及晚於 turn boundary 到達的累積式原文；句末數字與時間不再因音訊或事件排序而被截斷。

- 修正長會議分段切換、重連、暫停／繼續與停止期間的 stale Live callback 與 checkpoint context 汙染；舊 generation 不再寫入目前段落，未成功同步資料仍會保留。

- 翻譯紀錄保存失敗時補充顯示失敗階段、HTTP 狀態與安全錯誤代碼，方便診斷而不暴露內部錯誤細節。

- 合併長會議同步與音檔狀態訊息；未產生音檔時只顯示同步狀態，有音檔活動時在同一個訊息欄位顯示錄音狀態，音檔下載仍保留於翻譯紀錄詳細資料。

- 修正長時間錄音結束時的記憶體峰值：瀏覽器不再保留完整音檔或於 Stop 一次性組裝 WAV，音檔改由分段保存；畫面會引導使用者到翻譯紀錄下載。後端下載分段音檔時改為逐段串流，避免載入整個錄音。

- 字幕潤飾改為使用 Gemini Flash-Lite 純文字回應，移除 structured-output 設定；空白／純標點輸入會略過 provider，400 錯誤會安全保存 HTTP status、provider code、message、model 與 config 欄位摘要。

- 即時字幕不再依語言字數上限硬拆 Cue；完整句子會以 Gemini turn、句末、idle 或 Stop 作為邊界，潤飾失敗時保留原始翻譯並提供重試。

- Gemini 翻譯潤飾請求現在使用結構化 `polishedItems` schema，並安全正規化序號與 Cue 對應；無法完整可靠對應時整批失敗並保留原翻譯。

- 翻譯潤飾狀態改為顯示在即時字幕標題列的 Badge，不再於頁面底部新增獨立狀態面板；失敗時可直接在同列重試。

- 補齊翻譯潤飾狀態與重試 UI；歷史載入與即時更新現在會合併所有批次的潤飾結果，避免較早 Cue 在 reload 後遺失。

- 修正即時字幕與逐字稿在新的 final turn 重複數字或片段時，誤套用歷史前綴去重而漏字、漏翻譯；歷史前綴剝除現在只套用於非 final 的累積更新。

- 翻譯潤飾以整批 finalized 翻譯 Cue 作為上下文、逐句回傳 `polishedText`，並保留獨立文章版欄位；不回寫即時字幕、Raw Transcript 或 Live Translation。

- 修正長會議 checkpoint 與分段語音紀錄的暫時性保存失敗；未同步資料會在目前頁面工作階段保留並以退避間隔持續重試，成功後清除錯誤提示。

- 修正 Live Subtitle Cue 過早依 provider fragment finalize 的問題；同一 turn 的片段會先累積，中文短片段需達最小語意長度，turnComplete 以 700ms debounce 完成，並允許最後 1500ms 內的晚到雙語片段安全回併同一 Cue 與 checkpoint。

- 強化即時翻譯的數字與標點保真指令，避免翻譯語音與輸出逐字稿漏掉數字序列中的單一數字。

- 修正即時字幕 Cue 合併後沿用相同 `cueId` 導致長會議 checkpoint 衝突；現在只允許來源與翻譯文字單調追加的 `merged` Cue 更新，真正內容衝突仍會拒絕。

- Added an asynchronous transcript polishing pipeline for stable bilingual
  Cues. Gemini Flash Lite polishing runs through the existing queued translation
  execution infrastructure, persists versioned range/hash metadata, and is
  displayed separately from raw and live translation content without blocking
  the Live session.

- 修正即時字幕前綴短片段被拆成多列的問題；同一 Segment 中尚未完成的 Cue 會回併下一個句末片段，並改為優先依單字邊界換行。

- 即時語音輸入關閉瀏覽器的回音消除、降噪與自動增益，保留較原始的麥克風波形以改善語音辨識忠實度；單聲道、16kHz PCM 傳送流程不變。

- 修正同一段語音重複說出相同文字時被錯誤去重的問題；現在只有同一個 provider event 的重送會去重，不同發話事件即使文字相同也會各自保留。

- 修正即時字幕在原文先完成、翻譯稍後抵達時遺失翻譯的問題；翻譯會回填既有原文 Cue。當只有單側文字能安全切段時，改為保留單一完整雙語 Cue，避免 SRT／VTT 產生漏翻譯或重複翻譯。

- 即時 SRT／VTT 匯出改用雙語 final Cue；原文與翻譯下載會保留完全相同的 Cue 編號與時間軸。沒有 persisted Cue 的舊 Session、Meeting 與重新翻譯則會優先以原文時間窗對齊翻譯文字。

- 修正 boundary 先於原文或翻譯文字抵達時的即時字幕狀態；晚到的 transcript 會沿用已完成狀態，配對完成後不再停留在「辨識中／翻譯中」。

- 即時字幕會將同一個 Gemini Turn 的非累積來源／翻譯片段合併成單一暫存列，直到 `turnComplete`、`generationComplete` 或 transcript idle fallback 才完成，避免一句話被逐詞拆成多列，也避免缺少 boundary 時永久停留在 partial。

- Live Cue 在 turnComplete／generationComplete 後閒置 700ms 時，配對且足夠完整的 Cue 會完成；只有原文 Cue 會透過同一 Live session 重翻一次，重翻失敗則保留 partial，只有翻譯的幻聽片段不會保存。此機制不重開 session、不重送麥克風音訊，也不改變 token API。

- 即時字幕 Cue 超過語言字數目標時，會依子句、詞界或安全字元邊界拆成連續的雙語 Cue；短字幕不再因句尾標點提前切碎。Live transcript、Cue checkpoint 與新儲存逐字稿會忽略同一段語音的尾段重複文字（例如 `123` 後的 `3`），但保留 boundary 後真正重複的發話；Live 與歷史字幕 renderer 會依原文／譯文語言各自換行，每個 Cue 最多顯示兩行，儲存與匯出仍保留完整文字。

- AI Meeting Summary source contract closeout: summaries now use deterministic
  final-Cue or legacy-transcript sources with filtering, deduplication,
  conflict validation, source hashes, source metadata, and manual retry API/UI.

- AI Meeting Summary validation closeout: summary Cues now sort by Segment and
  sequence, partial Cues are excluded from source construction, and deterministic
  fake-provider E2E coverage verifies Stop completion, reload, and retry flows.

- 即時字幕不再顯示尚未配對原文的翻譯 partial，避免原文欄卡住空白的「辨識中／翻譯中」；原文到達後會保留並完成配對。

- 即時字幕不再依麥克風靜音猜測句子完成；字幕會保留到 Gemini boundary、句末標點或使用者明確 Pause／Stop，避免晚到翻譯被錯誤拆成孤立 partial。

- Session Detail now refreshes authoritative translation history alongside the
  session detail API so completed retranslation outputs replace stale pending
  executions and stop unnecessary polling.

- 即時字幕新增「複製原文」與「複製翻譯」，只會複製對應的已完成字幕；雙欄字幕的手動選取也不再連帶另一欄。

- WP8 Rich Meeting Summary: completed summaries now optionally persist and
  expose chronologically ordered timeline entries, keywords, risks, open
  questions, and follow-up suggestions across the summary API, UI, and PDF,
  Markdown, DOCX, and TXT exports. Legacy summaries remain readable.

- WP7 Meeting Summary Export: completed final summaries now provide PDF,
  Markdown, DOCX, and TXT downloads with structured sections and deterministic
  Session/timestamp filenames. Existing translation and subtitle exports are
  unchanged.

- WP6 Incremental Meeting Summary: finalized Meeting Segments now produce
  independently persisted, range-keyed partial summaries through the existing
  durable summary worker. Session finalization merges completed partials in
  chronological order; failed or missing partials remain retryable, and the
  existing Session summary API continues to return only the final summary.

- WP5 Summary Background Worker: completed Session finalization now enqueues
  durable, idempotent MeetingSummaryJobs. A separate worker persists completed
  or failed terminal job states, retries transient failures with exponential
  backoff, and recovers queued or expired jobs after restart without duplicating
  completed summaries.

- WP4 Meeting Summary UI: Session Detail now loads and displays pending,
  completed, failed, and missing meeting summaries with structured overview,
  topics, decisions, and action items.

- Added `GET /api/sessions/:sessionId/summary` for deterministic retrieval of
  completed, pending, and failed persisted meeting summaries.

- Added WP2 AI meeting summary persistence with Session association,
  immutable completed records, retained failed attempts, retry support, and
  memory/file-backed repositories.

- WP5A Subtitle Cue Exporter: Session detail TXT, SRT, and VTT downloads now
  use persisted final Cues when available, with deterministic filtering,
  sequence ordering, session-relative timeline validation, and
  language-aware export wrapping. Partial Cues never export; Sessions without
  Cues retain the legacy transcript fallback, while invalid Cue data fails
  explicitly instead of falling back.

- WP4 Closeout: migrated legacy live/history E2E assertions to the Cue UI
  contract. Coverage now verifies paired source/translation rows, final-only
  history Cues, reload fallback behavior, partial/final transitions, Stop
  flush, and follow-latest scroll protection. Existing live glossary replacement
  behavior is also applied to Cue translation display. The complete E2E suite
  passes 52/52 without restoring the legacy article tab.

- Live subtitle cue WP3: final Cues and recovery-only Cue checkpoints now use
  the existing file-backed Meeting/Segment checkpoint storage. Session detail
  reads expose merged, sequence-sorted final Cues while legacy transcript fields
  remain compatible; append and checkpoint writes are replay-safe across stop,
  rollover, reconnect, and reload recovery.

- Live subtitle cue WP1.5/WP2: strengthened the in-memory bilingual Cue
  engine with deterministic event identity, replay-safe snapshots, normalized
  session-relative timelines, out-of-order source/translation pairing, and
  atomic length fallback. Gemini Live messages now pass through a dedicated
  normalized-event adapter into Cue state while the existing transcript UI and
  persistence paths remain unchanged. Cue persistence, history APIs, and Cue
  UI remain deferred.

- Long recording history persistence: session snapshot JSON uploads now use a
  configurable `SESSION_SNAPSHOT_MAX_BYTES` limit with a `25MB` default, live
  transcript history sync sends only newly finalized items, and saved WAV audio
  can persist as ordered segments while history downloads still return one WAV.
  Oversized transcript or audio requests now produce clearer, independent UI
  errors without blocking the other persistence path.

- Long Meeting checkpoint synchronization now uses a dedicated configurable
  `MEETING_CHECKPOINT_MAX_BYTES` limit with a `25MB` default instead of the
  general 10KB JSON request limit, preventing background saves from failing as
  checkpoint transcript history grows.

- Translation History audio artifacts: finalized translated audio, and optional
  original speaker recording when enabled, are now uploaded to backend file
  storage when a Session ends. Session and Long Meeting detail views expose
  saved WAV download links from history, with Meeting downloads resolving the
  whole-meeting artifact.

- Translation History navigation merge: the visible history navigation is now a
  single `#history` / 翻譯紀錄 entry. The page shows regular saved translation
  Sessions and Long Meeting summaries in one chronological list, while the
  existing Meeting read/detail APIs and legacy `#meetings` hash remain available
  internally for compatibility.

- Long Meeting WP7 reliability and stress validation: added deterministic
  accelerated 2+ hour Meeting scenario coverage across 14 ordered Segments,
  including proactive rollover, token-expiration recovery, network recovery,
  file-backed persistence reload, full transcript reconstruction, duplicate and
  ordering checks, and failed-Segment readable checkpoint coverage. E2E coverage
  now also verifies browser-suspended wake recovery and explicit resource
  diagnostics after long-meeting Stop. Existing Gemini Live path,
  `/api/live-token`, UI flow, and real API usage remain unchanged.

- Long Meeting WP6 meeting history/detail and whole-meeting export page: added
  read-only Meeting history and detail APIs, a dedicated `#meetings` UI with
  Segment timeline/statuses, per-Segment source/translation browsing,
  whole-meeting source transcript and translation article views, plus
  TXT/SRT/VTT export controls backed by deterministic export tests. Interrupted
  and failed Segments remain visible with preserved checkpoint content. Existing
  single Session export, Gemini Live path, and live-token security behavior are
  unchanged.

- Long Meeting WP5 frontend resource closeout: archived live transcript rendering
  now uses a bounded recent-Segment cache with diagnostics for archived,
  loaded, and active Segment counts. Live session cleanup now clears audio
  processing callbacks, playback handlers, pending transcript references,
  media tracks, AudioContext, and Live session references idempotently. E2E
  coverage verifies long-meeting Stop releases mocked mic tracks, AudioContexts,
  Live sessions, and cancels further rollover scheduling.

- Long Meeting WP5 frontend archived view: live meeting article panels now keep
  completed prior Segments visible through an archived transcript view while the
  active transcript state is reset for the current Segment after rollover,
  reconnect recovery, or reload resume. The live UI now shows a compact archived
  Segment/current Segment count diagnostic. Backend token flow and Gemini Live
  session behavior are unchanged.

- Long Meeting WP5 API foundation: session detail reads can now materialize
  archived Segment transcript content from Meeting checkpoints when a
  SessionRecord references a Meeting. Existing `/api/sessions/:sessionId`
  response shape, Meeting checkpoint endpoints, Gemini Live path, and live-token
  security behavior remain unchanged. Frontend virtualized rendering and audio
  resource cleanup hardening remain deferred.

- Long Meeting WP4 Live/token recovery: added a Segment recovery endpoint that
  persists a final checkpoint, marks the active Segment as interrupted or failed,
  and creates the next active Segment for interrupted recovery with a fresh Live
  session association. The live UI now uses this path for controlled reconnect
  after unexpected close or token expiration while preserving visible transcript
  and avoiding duplicate history records. Opening `#live?meetingId=...` now
  reloads Segment checkpoints into the live transcript and offers manual resume
  into the next recovered Segment. Proactive token refresh, offline pause/resume,
  and device-disconnect recovery remain deferred.

- Long Meeting WP3 proactive segmentation and Live continuity: live sessions now
  default to scheduled 10-minute Segment rollover with a 15-minute code cap,
  complete the current Segment with a final checkpoint, create the next ordered
  active Segment with a fresh Live session association, and replace the browser
  Gemini Live session while preserving the visible transcript. This does not
  change the `/api/live-token` security model, browser-to-Gemini audio path,
  general reconnect scope, or token refresh behavior.

- Long Meeting WP2 frontend checkpoint sync: live sessions now create a Meeting
  and first Segment by default, attach their identifiers to the saved
  SessionRecord, and sync confirmed source/translation chunks to the checkpoint
  API on a short debounce and on Stop. Failed checkpoint writes keep live
  translation running, retain unsynced chunks for retry, and show a retryable UI
  status. No proactive segmentation, Live reconnect, segment switching, or
  checkpoint restore behavior was added.

- Long Meeting WP2 backend checkpoint API: added backend Meeting creation,
  Segment listing, and Segment checkpoint read/write APIs with file-backed
  meeting repository production wiring. Checkpoint writes are idempotent for
  repeated confirmed chunks, reject conflicting duplicate keys or stream
  sequences, and keep pending partial text out of durable storage. No frontend
  live flow, Gemini Live session, proactive segmentation, or reconnect behavior
  changed.

- Long Meeting WP1 foundation: added Meeting and MeetingSegment domain models,
  a MeetingRepository contract, in-memory and file-backed repository adapters,
  and optional `meetingId` / `segmentId` compatibility fields on SessionRecord.
  No Live API, token, UI, or reconnect behavior changed.

- Phase 3J WP5 Dead-letter Queue Transfer: terminal durable failures now persist
  their execution failure before an ownership-checked DLQ transfer. The DLQ is
  written idempotently by `executionId` before the durable item is removed;
  failed transfers retain the main item and startup recovery retries transfer
  only, without provider replay.

- Phase 3J WP4 Backoff-aware Runtime Scheduling: durable availability queries,
  recovery filtering, and single-timer runtime wake-ups now honor `availableAt`.
  Delayed retries remain durable until due.

- Phase 3J WP3 Worker Retry Requeue: durable Workers now classify deferred
  provider failures, atomically release their owned queue claim into a retry
  item, and resume the execution as queued when attempts remain. Terminal
  failures retain acknowledgement behavior; runtime scheduling and DLQ transfer
  remain deferred.

- Phase 3J WP2 Retry Policy & Error Classification: added queue-level retry
  policy and deterministic provider-error classification to production
  composition, separate from the Phase 2L Runner retry policy. Worker, Runtime,
  scheduling, execution lifecycle, and DLQ transfer behavior remain unchanged.

- Phase 3J WP1 Retry / Dead-letter Data Contracts: durable queue items now
  persist validated retry metadata (`attempt`, `availableAt`, and `lastFailure`)
  with legacy defaults. Added fake and file-backed dead-letter queue repositories
  for FIFO, deterministic JSON storage, and reload persistence; no Worker,
  Runtime, HTTP, retry scheduling, or dead-letter transfer behavior changed.

- Phase 3H WP5 Lease Lifecycle Vertical Integration & Documentation Closeout:
  completed production-composition coverage for normal claims, active leases,
  expired reclaim/new ownership, stale acknowledgement rejection, and reclaimed
  provider failure. Phase 3H is complete; renewal, fencing, retry/DLQ, and
  distributed coordination remain deferred.

- Phase 3H WP4 Lease Ownership-aware Acknowledgement: durable workers now
  remove processing items only through lease-matching `acknowledgeClaim`, while
  startup reconciliation retains its system `acknowledge` removal path.

- Phase 3H WP3 Lease-aware Startup Recovery and Expired Lease Reclaim:
  startup recovery now uses `leaseExpiresAt` as the sole processing ownership
  expiry decision, reclaims eligible expired items through `queued`, and leaves
  active leases and terminal execution reconciliation unchanged.

- Phase 3H WP2 Worker Lease Claim Integration: durable workers now validate and
  generate claim lease metadata before Runner execution, preserve `claimedAt`
  for recovery compatibility, and receive lease duration, clock, and ID factory
  dependencies only when the durable queue is enabled.

- Phase 3H WP1 Durable Queue Lease Metadata & Repository Contract: made
  `leaseId` and `leaseExpiresAt` required for durable processing items, with
  validation, atomic claim support, fake/file adapter persistence, legacy
  queued-item loading, and focused contract tests.

## Unreleased

### Changed

- Simplified `main.jsx` by removing the unused saved-session retranslation UI and
  old route compatibility layer. Saved retranslation backend contracts and live
  subtitle correction remain available; removed hashes now fall back to
  `#meetings`.

- Original speaker audio recording now defaults off and can be enabled before
  starting a live session; disabling it still allows live translation while
  preventing local original-audio download creation.

- Live glossary instructions now explicitly ask Gemini to use configured terms
  in translated speech audio as well as output transcription, while the browser
  still applies deterministic subtitle replacement. The live reading headings
  now use 原文逐字稿 / 翻譯逐字稿.

- Production startup now uses `npm run start` to run the Node server in
  production mode, serving both `/api/*` and built `dist/` frontend assets.
  File-backed persistence defaults are rooted at `DATA_DIR`, using `/var/data`
  in production when unset.

- Translation history now lists only live translation Sessions. Completed
  saved-session retranslation outputs remain available from the retranslation
  workflow but are no longer materialized as separate history records.

- Live and saved retranslation reading views now share subtitle-merged
  transcript formatting, including extra whitespace removal for adjacent CJK
  subtitle segments.

- Saved-session retranslation now wakes the execution worker immediately after
  submission, exposes provider attempt timing in progress read models, and
  applies a configurable Gemini timeout through
  `SAVED_RETRANSLATION_TIMEOUT_MS`.

- Completed saved-session retranslation no longer replaces the original
  session's main article view or creates a separate history record.

- Default backend startup now assembles the Gemini translation runtime whenever
  `GEMINI_API_KEY` is configured and starts the translation execution worker, so
  queued saved-session retranslation can complete and persist outputs to
  `data/session-records.json`. Startup also restores persisted queued
  retranslation executions from file-backed session records into the active
  worker queue.

- Failed saved-session retranslation executions now persist safe provider error
  details for diagnosis. Mixed-language source transcripts no longer send the
  synthetic `mixed` value as a Gemini source-language hint.

- History detail now shows a user-facing reason when saved-session
  retranslation fails.

- Production session records now default to file-backed storage at
  `data/session-records.json` when `SESSION_RECORDS_FILE` is unset. Explicit
  `SESSION_RECORDS_FILE` configuration continues to override the path.

- Translation glossary UI now models entries as deterministic subtitle
  replacement rules: `詞條` is the translated subtitle text to find and
  `替換成` is the displayed text. Legacy `replacementAliases` JSON remains
  readable for compatibility, but the UI no longer creates alias fields.

- Live translation now defaults the target language to English (`en`) in the UI
  and live-token fallback. Source article reading, copy, and TXT export now
  normalize Chinese text to Taiwan Traditional Chinese while preserving the
  canonical transcript items.

### Added

- Live translation now lets users choose a primary input language before
  starting a session. The value defaults to Traditional Chinese (`zh-Hant`), is
  stored with session metadata, and is sent as a soft Gemini system-instruction
  hint while preserving mixed-language speech.

- Translation history now supports deleting finalized Session records from the
  history page through `DELETE /api/sessions/:sessionId`.

- Saved-session retranslation results can now be deleted from the retranslation
  workflow without removing the source Session or request/execution history.

- Added a dedicated `#retranslate` workflow for saved Session re-translation.
  History detail now links into the workflow with the selected Session ID, while
  the new page can also be opened without a selected Session to search and pick
  an original saved Session. The workflow keeps original transcript and
  article-style retranslation output in a two-column reading view, supports
  provider/target-language selection, pending/completed/failed status display,
  failed retry, version switching, and TXT export of the selected retranslation
  output.

- Re-translation output export now supports source or translation TXT, SRT, and
  VTT downloads with the same single-stream subtitle restriction as live and
  saved Session exports.

- Added `GET /api/translation-providers` so the frontend can show only
  backend-supported, safe provider options for saved Session re-translation.

- Translation glossary entries now support `live`, `history`, and `both` scopes.
  The glossary UI is available as its own `#glossary` page; live sessions use
  only live/both entries through the server-issued Live connect config, while
  saved retranslation uses only history/both entries.

- Optional backend file-backed SessionRepository persistence via
  `SESSION_RECORDS_FILE`, plus global manual glossary CRUD through
  `TRANSLATION_GLOSSARY_FILE` and history-page UI. Saved sessions, canonical
  transcript items, translation requests/executions/outputs, and glossary terms
  can now survive reload/restart in the single-node internal-tool scope.

- Live transcript panels now default to local article-style reading: final source
  and translation segments render as deterministic paragraphs, pending text
  remains a separate recognition/translation status, and raw transcript export
  remains unchanged.

- Translation history UI is now a dedicated `#history` page alongside the
  `#live` workspace. Navigation preserves the active session, selected history
  detail, pending execution polling, and formal-output export state; backend
  contracts and legacy export compatibility are unchanged.

- User-initiated Stop now finalizes visible pending transcript items before
  Session finalization, so current and saved TXT/SRT/VTT exports retain the
  last displayed source and translation text.

- Phase 4C WP1–WP6 Execution Control closeout: added terminal `cancelled`
  execution state with queued-only cancellation; failed-only manual retry that
  creates a distinct queued execution while preserving the failed source;
  cancel/retry HTTP controls; history UI controls with polling reconciliation;
  and Worker/recovery no-op safety for cancelled active or durable queue items.
  Cancellation does not abort running provider work. No cancellation
  reason/actor, batch or scheduled cancellation, cancelled-execution retry, or
  retry-lineage UI was added; existing retry scheduling, lease/fence, reclaim,
  and DLQ behavior remains unchanged.

- Phase 4B WP5 Documentation and Release Closeout: documented Session
  re-translation and allowlisted target selection; multi-language,
  multi-version formal outputs with deterministic version allocation and
  execution-level output idempotency; history read-model precedence and legacy
  fallback/error isolation; durable request reconstruction, reclaim/recovery,
  lease/fence, and DLQ boundaries; and history polling, stale-response cleanup,
  selected-output TXT/SRT/VTT export. Provider-side Gemini de-duplication,
  manual retry/cancel, DLQ UI, and cross-Session search remain out of scope.

- Phase 4B WP2 Multi-output Persistence and Read Model: formal outputs now
  retain canonical request/source metadata and a monotonic per-session,
  per-target-language version. Translation history exposes completed outputs
  separately from executions that do not yet have an output.

- Phase 4B WP1 Re-translation Command Contract: added `POST
  /api/sessions/:sessionId/retranslations`, which derives immutable source input
  from canonical final Session transcript items and creates a new queued request
  and execution through the existing durable queue path without provider calls
  or output creation.

- Phase 4A closeout: restored full-suite test fixtures and assertions to the
  Phase 3K durable queue/provider-attempt contract, added deterministic history
  UI E2E coverage, and documented production/manual Gemini smoke-test setup.
  Automated tests remain fake-provider only.

- Phase 4A WP4 Translation History Read API and UI: `GET
  /api/sessions/:sessionId/translations` reads canonical session translation
  records with optional allowlisted target-language filtering. Session detail
  now displays request, execution, output, and source-item detection metadata
  read-only, without provider or queue activity.

- Phase 4A WP3 Configurable Translation Glossary: optional JSON glossary
  entries are validated against the target-language allowlist and selectively
  supplied as Gemini translation instructions. Missing configuration is a
  compatible no-op; malformed entries fail explicitly. Source text, provider
  request count, retry/idempotency behavior, and persisted outputs remain
  unchanged.

- Phase 4A WP2 Mixed-Language Source Detection Metadata: canonical source
  `TranscriptItem` records now optionally retain multiple detected source
  language codes plus explicit detection coverage. Metadata survives session
  snapshot rehydration, while legacy items without it remain valid. The
  production Gemini translation adapter currently exposes only a single
  translation-result language signal, not reliable item-level mixed-language
  detection; WP2 adds no provider call, text rewriting, or output/session-level
  detection metadata.

- Phase 4A WP1 Target Language Selection: existing allowlisted target-language
  choices now pass through live session command persistence and saved-transcript
  retranslation consistently. Translation request and output command boundaries,
  saved-transcript retranslation, and live-token issuance reject blank,
  malformed, and unsupported supplied language codes without fallback; omitted
  live-token target language retains the existing `zh-Hant` default.

- Phase 3K WP6 Documentation & Regression Closeout: documented stable provider
  keys, attempt intent, result snapshots, reconciliation, and capability-aware
  reclaim. Gemini remains `unknown`; cross-process atomicity, distributed
  locking, event deduplication, and observability remain future reliability work.
- Phase 3K WP4 Provider Result Persistence & Output Reconciliation: succeeded
  provider attempts now persist a validated result snapshot before output and
  completion writes; reclaimed succeeded attempts reconcile without provider replay.
- Phase 3K WP3 Provider Attempt Persistence & Recovery Boundary: executions
  now persist provider attempt intent and terminal attempt metadata around each
  provider call. Reclaimed `in_flight` attempts remain a conservative no-replay
  boundary; remote result recovery remains deferred.
- Phase 3K WP2 Provider Input Propagation: persisted execution idempotency keys
  now flow through the Runner and provider adapters into Gemini request metadata
  as `idempotencyKey`; prompts, responses, retries, and HTTP contracts remain
  unchanged.
- Phase 3K WP1 Provider Execution Idempotency Contract: `TranslationExecution`
  now deterministically derives and persists an immutable provider idempotency
  key from its execution ID. Legacy persisted executions without the key
  reconstitute compatibly without a read-time rewrite; provider invocation and
  HTTP contracts remain unchanged.
- Phase 3I Lease Renewal & Execution Fencing: completed heartbeat renewal,
  monotonic fence-token claims, fenced output/terminal persistence, and
  token-aware acknowledgement with production-composition verification using
  deterministic fake clocks, schedulers, and providers. Documentation records
  remaining transaction, idempotency, retry, locking, and observability limits.
- Phase 3G WP6 Failed Execution Reconciliation: startup recovery now marks and
  acknowledges an expired processing durable item as failed only when the
  execution is already failed and has no output. Failure state and metadata are
  retained unchanged; failed durable acknowledgement errors retain state and
  propagate unchanged for a safe later startup acknowledgement.
- Phase 3G WP5 Output-bearing Running Execution Reconciliation: startup
  recovery now completes an expired processing `running` execution only when
  its output is already persisted, via the existing command-service domain
  transition. It then marks and acknowledges the durable item without provider
  replay or output mutation. Completed durable items retry acknowledgement only
  when their execution is completed with output; acknowledgement errors retain
  all state and propagate unchanged.
- Phase 3G WP4 Running Execution Recovery Policy: startup recovery now checks
  execution and output state before requeueing an expired processing lease.
  Output-less `running` executions use the explicit domain recovery transition
  back to `queued` and may safely replay; terminal, missing, and invalid output
  state combinations remain durable without provider replay or output mutation.
- Phase 3G WP3 Expired Processing Lease Recovery: startup recovery now keeps
  queued FIFO replay and atomically requeues only expired processing items with
  complete lease metadata. Requeue clears the lease before active enqueue;
  valid leases, legacy processing items, and terminal items remain untouched.
  Crash-after-claim/before-Runner integration coverage verifies both successful
  and failed terminal acknowledgement paths.
- Phase 3G WP2 Worker Lease Claim Integration: feature-enabled workers now
  create an injected-clock, injected-ID lease and atomically claim the durable
  queue item before Runner execution. Claim failures propagate without invoking
  the Runner or provider and leave execution lifecycle/output work untouched;
  terminal acknowledgement behavior remains unchanged. Lease expiry recovery,
  renewal, retry, timeout, DLQ, and multi-worker locking remain deferred.
- Phase 3G WP1 Lease-aware Durable Queue Contract: durable `processing` queue
  items now carry a complete `leaseId`, `claimedAt`, and `leaseExpiresAt`
  record. `claim()` atomically performs `queued → processing`; terminal status
  updates clear all lease metadata. File-backed storage preserves complete
  processing leases across reload while accepting legacy lease-less processing
  items without replaying, repairing, deleting, or rewriting them. Worker,
  recovery, retry, expiry recovery, timeout, DLQ, and multi-worker behavior
  remain deferred.
- Phase 3F Documentation Closeout: documented the durable acknowledgement
  contract and terminal cleanup: items are removed only after `completed` or
  `failed` execution persistence, while acknowledgement failures retain the
  item and propagate unchanged. Startup recovery now replays only `queued`
  items; `processing`, `completed`, and `failed` items remain stored without
  replay or removal. Production-composition integration coverage verifies
  successful and failed terminal cleanup, recovery eligibility, and
  acknowledgement-failure retention with a fake provider. Processing-item
  crash recovery; lease, heartbeat, and visibility-timeout recovery policy;
  retry/backoff; dead-letter queues; and multi-worker locking or cross-process
  deduplication policy remain deferred.
- Phase 3E WP8 Documentation Closeout: documented durable and active queue
  identity, idempotent enqueue and recovery, lifecycle safeguards, output
  uniqueness, and production-composition vertical coverage. The README,
  architecture documents, and roadmap now record the remaining limitations:
  no multi-process exactly-once delivery, provider idempotency, or event
  publishing deduplication.
- Phase 3E WP7 Deduplication & Recovery Vertical Integration Tests: added
  production-composition coverage with a fake provider for duplicate durable
  submission, repeated FIFO recovery, terminal durable items, and worker
  lifecycle skips. The scenarios verify a single provider invocation and
  output per processable execution without external API calls.
- Phase 3E WP6 Output Uniqueness Protection: translation output persistence is
  now idempotent by execution ID. The first output remains authoritative, and
  later create attempts return it without overwriting content, metadata, or
  timestamps.
- Phase 3E WP5 Worker Lifecycle Guard: workers now return an
  `execution_not_processable` skip result for persisted created, running,
  completed, or failed executions. Skipped jobs load their request but do not
  claim or change durable items, invoke providers, create outputs, or update
  execution lifecycle state.
- Phase 3E WP4 Idempotent Startup Recovery: recovery now rejects conflicting
  persisted queue identities before replay or lease release, replays only
  queued and lease-expired processing items, and leaves completed and failed
  items untouched. Repeated recovery relies on active queue idempotency to
  preserve a single FIFO work item without changing durable item metadata.
- Phase 3E WP3 Active In-Memory Queue Deduplication: active execution queue
  enqueue now uses the shared durable identity contract. Matching identities are
  no-ops that retain FIFO order; conflicting request identities fail with
  `translation_execution_queue_item_conflict`; executions may be enqueued again
  after dequeue. Dual-write and recovery coverage verifies no duplicate active
  work is created.
- Phase 3E WP2 Idempotent Durable Enqueue: durable repository enqueue now
  explicitly preserves the existing item as a no-op for matching queue item
  identity. Repeated writes retain FIFO position, status, lease, timestamps,
  and all persisted fields, including after file-backed repository reload.
- Phase 3E WP1 Durable Queue Identity Contract: centralized durable queue item
  identity comparison on `executionId` and `requestId`. Re-enqueueing the same
  identity preserves the existing no-op behavior, while an existing
  `executionId` paired with a different `requestId` now fails deterministically
  with `translation_execution_queue_item_conflict`. The fake and file-backed
  repositories share contract coverage, including file reload semantics; FIFO,
  status lifecycle, and JSON persistence format remain unchanged.
- Phase 3D WP5 Lease & Visibility Timeout: durable queue items now persist an
  optional `leasedUntil` timestamp, legacy items load with no lease, and the
  repository supports claim, expiry inspection, and expired-lease release.
  Workers acquire a five-minute configurable lease before processing; startup
  recovery releases expired leases and replays only eligible queued or expired
  processing items. No renewal, retry, distributed locking, or multi-worker
  coordination was added.
- Phase 3D WP4 Durable Queue Deduplication: added read-only
  `contains(executionId)` to the durable queue repository contract and its fake
  and file-backed adapters. Durable enqueue is now idempotent by execution ID;
  duplicate writes preserve the original item, status, and FIFO order. The
  dual-write queue checks durable existence before enqueueing the active queue,
  and startup recovery replays each execution at most once across repeated
  recovery calls without removing durable items. Acknowledgement still permits
  a later enqueue of the same execution. No distributed locking, lease,
  visibility timeout, retry, transactional enqueue, or multi-worker behavior
  was added.
- Phase 3D WP3 Completion Acknowledgement: extended the durable queue
  repository contract and its fake and file-backed adapters with
  `acknowledge(executionId)`, which removes an existing durable item while
  preserving remaining FIFO order and fails deterministically for missing
  items. The Translation Execution Worker now claims an item, runs the Runner,
  and acknowledges only after the Runner completes or fails, so durable items
  remain through startup replay and terminal execution persistence. An
  acknowledgement error propagates unchanged without retrying the Runner or
  provider; a runner failure is still rethrown after successful cleanup. No
  retry, acknowledgement retry, lease, visibility timeout, deduplication,
  multi-worker support, distributed locking, or transactional persistence was
  added.
- Phase 3D WP2 Worker Claim: wired the durable queue repository into the
  Translation Execution Worker when the durable queue feature is enabled, so the
  Worker now persists a durable queue item claim by updating `queued` to
  `processing` before starting the runner. Claim failures propagate unchanged
  and prevent runner/provider execution. Startup recovery now replays durable
  items with `list -> active enqueue` and no longer removes them during replay,
  leaving durable removal for future acknowledgement work. No HTTP API,
  `TranslationExecution` lifecycle, provider behavior, retry, lease, visibility
  timeout, recovery filtering, deduplication, dead-letter queue, locking, or
  multi-worker coordination was added.
- Phase 3D WP1 Durable Queue Item Lifecycle: added a centralized immutable
  durable queue item status set with `queued`, `processing`, `completed`, and
  `failed`, defaulted new durable queue items to `queued`, and extended the
  durable queue repository contract with `updateStatus`. The fake and
  file-backed durable queue repositories now persist status updates without
  changing item identity, payload, ordering, or item count, reject invalid
  statuses, and fail deterministically for missing items. File-backed storage
  remains backward compatible for older items without `status` by loading them
  as `queued`, while invalid persisted statuses remain storage errors. No
  Worker claim, runtime transition, acknowledgement, completion-driven removal,
  retry, lease, visibility timeout, dead-letter queue, startup recovery
  filtering, HTTP API, provider execution, or `TranslationExecution` lifecycle
  behavior changed.
- Phase 3C WP7 Documentation Closeout: updated README, ROADMAP, architecture
  overview, and the main architecture document to reflect the current Durable
  Queue foundation, including feature-gated composition, dual-write enqueue
  persistence, file-backed durable repository storage, startup recovery, replay
  flow, and Phase 3C completion. The documentation now explicitly records the
  current limitations: durable items are removed immediately after startup
  replay into the active queue, and acknowledgement, completion-driven removal,
  replay deduplication, lease, visibility timeout, retry, dead-letter queue,
  multi-worker support, locking, and concurrency control remain future work. No
  production runtime, Worker, queue, repository, recovery, replay, HTTP API,
  configuration, execution lifecycle, or test behavior changed.
- Phase 3C WP6 Startup Recovery / Durable Queue Replay: added the Startup
  Translation Execution Queue Recovery application service that replays durable
  queue items one at a time with `peek -> active enqueue -> durable dequeue`,
  preserves FIFO order, converts durable items back to the active queue
  `{ executionId, requestId }` schema, and stops with original error propagation
  on peek, active enqueue, or durable dequeue failures. Production composition
  now creates recovery only when `TRANSLATION_DURABLE_QUEUE_ENABLED=true` and
  wraps Worker Runtime startup so recovery completes before polling starts.
  Recovery targets the underlying in-memory primary queue used by the active
  dual-write queue. No HTTP API, execution lifecycle, Worker processing logic,
  acknowledgement, durable dequeue after success, replay deduplication, lease,
  visibility timeout, retry, dead-letter queue, reconciliation, locking,
  multi-worker, concurrency, or metrics behavior changed.
- Phase 3C WP5 Dual-write Enqueue Persistence: added the dual-write
  Translation Execution Queue adapter that writes durable queue items with
  deterministic `enqueuedAt` timestamps before enqueueing the existing
  in-memory primary queue, delegates `dequeue` and `size` only to the primary
  queue, preserves caller input immutability, and propagates durable and primary
  write failures unchanged without rollback or compensation. Production
  composition now uses the dual-write queue only when
  `TRANSLATION_DURABLE_QUEUE_ENABLED=true`, while the disabled path keeps the
  existing in-memory queue behavior. Feature-enabled vertical coverage verifies
  `POST /api/translation-executions` persists the durable item and enqueues the
  in-memory job without changing the HTTP `202` response shape, Worker Runtime,
  durable dequeue behavior, execution lifecycle, restart recovery, replay,
  acknowledgement, lease, retry, dead-letter queue, locking, concurrency, or
  metrics behavior.
- Phase 3C WP4 Production Composition Wiring: added Translation Queue
  Configuration for `TRANSLATION_DURABLE_QUEUE_ENABLED` and
  `TRANSLATION_DURABLE_QUEUE_FILE`, and wired production composition to create
  the file-backed durable queue repository only when the feature flag is
  enabled. The repository is exposed as
  `durableTranslationExecutionQueueRepository` for future work, while the
  active `TranslationExecutionQueue` remains the existing in-memory queue by
  default and when the durable repository is enabled. No durable queue
  activation, queue replacement, Worker Runtime integration, enqueue/dequeue
  persistence, worker replay, restart recovery, HTTP API, execution lifecycle,
  acknowledgement, lease, retry, dead-letter queue, concurrency, or metrics
  behavior changed.
- Phase 3C WP3 File-backed Durable Translation Execution Queue Repository:
  added the JSON file-backed durable queue repository adapter with async
  `enqueue`, `peek`, `dequeue`, `size`, and `clear`, pretty UTF-8 storage using
  deterministic item key order, full-file read/write semantics, FIFO behavior,
  reload persistence, and deterministic
  `invalid_translation_execution_queue_storage` failures for corrupted storage.
  The adapter passes the reusable durable queue repository contract and
  adapter-specific storage tests. No production composition, Worker Runtime,
  Worker, HTTP API, execution lifecycle, restart recovery, replay, file locking,
  acknowledgement, lease, retry, dead-letter queue, concurrency, or metrics
  behavior changed.
- Phase 3C WP2 Durable Translation Execution Queue Repository Contract: added
  the durable queue repository application port with `enqueue`, `dequeue`,
  `peek`, `size`, and `clear`, defined the durable queue item schema with
  `executionId`, `requestId`, and ISO UTC `enqueuedAt`, and added stable
  validation using `invalid_translation_execution_queue_item`. Added a fake
  in-memory durable queue repository plus reusable contract coverage for FIFO,
  peek without removal, dequeue removal, size, clear, empty queue `null`
  behavior, validation failure state preservation, input immutability, and
  immutable dequeue results. No production composition, Worker Runtime, HTTP
  API, execution lifecycle, durable storage, restart recovery, lease,
  acknowledgement, retry, dead-letter queue, concurrency, or metrics behavior
  changed.
- Phase 3C WP1 Translation Execution Queue Port Contract: tightened the
  Translation Execution Queue application port to the minimal `enqueue`,
  `dequeue`, and `size` contract, added stable queue-item validation with the
  `invalid_translation_execution_queue_item` code, normalized empty dequeue to
  `null`, and added reusable contract coverage for FIFO ordering, empty
  dequeue, size/removal semantics, validation failures, queue-state preservation,
  and input immutability. The production in-memory queue now passes the same
  contract tests. Runtime polling continues to use the same queue and worker
  lifecycle through `size()` without adding durable persistence, recovery,
  retry, lease, acknowledgement, dead-letter queue, concurrency, metrics, or
  HTTP behavior changes.
- Phase 3B WP6 Documentation Closeout: completed documentation for Queue
  Abstraction, Worker Runtime Lifecycle (`start`, `stop`, `restart`, and
  `isRunning`), Worker Loop behavior, graceful shutdown, production Runtime
  integration, and current limitations including no automatic Runtime startup,
  in-memory queue only, no durable or external queue, no retry, no timeout, no
  cancellation, no priority scheduling, no parallel workers, and no metrics.
  Updated README, ROADMAP, architecture overview, and changelog only. No
  production code, test logic, HTTP API, execution lifecycle, FIFO queue,
  Worker, Runtime, retry, timeout, cancellation, or external queue behavior
  changed.
- Phase 3B WP5 Runtime Integration: added production vertical integration
  coverage proving Queue, Worker, and Worker Runtime collaborate through the
  production composition graph. Coverage verifies `POST -> Queue -> Worker ->
  completed`, confirms queued executions remain `queued` while the Runtime is
  not started, proves Runtime start completes existing queue work, verifies
  Runtime stop leaves newly submitted work queued, and proves restart resumes
  remaining FIFO work. No HTTP API, execution lifecycle, FIFO queue, retry,
  timeout, cancellation, parallel worker, or external queue behavior changed.
- Phase 3B WP4 Graceful Shutdown: refined
  `TranslationExecutionWorkerRuntime.stop()` so it prevents future polling and
  new queue work while allowing an in-flight Worker execution to finish before
  the runtime reports stopped. Focused coverage verifies in-flight work
  completion, Worker Loop shutdown after the current job, queued work after
  stop remaining unprocessed, and restart processing the remaining queue work.
  No FIFO queue, HTTP API, execution lifecycle, retry, timeout, cancellation,
  automatic startup, or parallel worker behavior changed.
- Phase 3B WP3 Worker Loop: made `TranslationExecutionWorkerRuntime` poll the
  shared Queue abstraction before invoking the Worker, so an empty queue waits
  for the next scheduled poll without repeatedly executing idle worker work,
  while newly enqueued jobs are processed on later polls without restarting the
  runtime. Focused coverage verifies empty-queue waiting, automatic recovery
  after enqueue, FIFO processing across multiple jobs, and continued waiting
  after a job completes. No FIFO queue, HTTP API, execution lifecycle, retry,
  timeout, cancellation, graceful shutdown, or parallel worker behavior changed.
- Phase 3B WP2 Worker Runtime Lifecycle: added explicit
  `TranslationExecutionWorkerRuntime.isRunning()` state, verified safe
  start/stop/restart behavior, kept repeated `start()` from creating multiple
  polling loops, kept repeated or pre-start `stop()` safe, and wired production
  composition to create and expose the Worker Runtime without automatically
  starting it. No FIFO queue, HTTP API, execution lifecycle, retry, timeout,
  cancellation, graceful shutdown, or parallel worker behavior changed.
- Phase 3B WP1 Queue Abstraction: formalized the Translation Execution Queue
  application contract around `enqueue(item)`, `dequeue()`, `isEmpty()`, and
  `size()`, updated the in-memory FIFO queue to implement that contract,
  switched worker, command, and composition validation to the shared queue
  abstraction, and added focused contract coverage for FIFO dequeue order,
  empty dequeue behavior, queue size/emptiness state, alternate queue
  implementations, and production in-memory queue composition. No HTTP API,
  execution lifecycle, retry, timeout, cancellation, priority, parallel worker,
  or external queue behavior was added.
- Phase 3A WP10 Documentation Closeout: documented Async Execution Runtime,
  Queue / Worker architecture, `202 Accepted` asynchronous submission for
  `POST /api/translation-executions`, Worker Runtime polling behavior, and
  current implementation limitations including in-memory queue only, no
  automatic runtime startup, no durable queue, no cancellation, no timeout, no
  multi-worker processing, and no metrics. No production code, tests, HTTP
  contract, queue, worker, runner, retry policy, provider resolver, or
  persistence-format behavior changed.
- Phase 2P WP6 Documentation Closeout: completed Translation Execution
  Lifecycle documentation and closeout. README and ROADMAP now document the
  implemented `TranslationExecution` statuses (`created`, `queued`, `running`,
  `completed`, `failed`), the success lifecycle (`created`, `queued`,
  `running`, `completed`), the provider-failure lifecycle (`created`, `queued`,
  `running`, `failed`), provider execution after persisted `running`, output
  persistence before `completed`, no output on failure, unchanged provider-error
  propagation, and Phase 2P completion. No production code, tests, retry, queue
  runtime, timeout, cancellation, metrics, provider behavior, HTTP contract, or
  persistence-format behavior changed.
- Phase 2P WP5 Execution Lifecycle Vertical Integration: extended production
  composition vertical integration coverage to verify persisted
  `TranslationExecution` lifecycle order for successful execution (`created`,
  `queued`, `running`, `completed`) and provider failure (`created`, `queued`,
  `running`, `failed`). Coverage verifies `TranslationOutput` is created only
  on success, no output is created on failure, provider errors are propagated
  unchanged through the application boundary, and existing HTTP/provider
  behavior remains unchanged. No retry, queue runtime, timeout, cancellation,
  metrics, provider, or persistence-format behavior was added.
- Phase 2P WP4 Lifecycle Unit Test Consolidation: consolidated focused
  `TranslationCommandService` lifecycle coverage to assert exact persisted
  execution status order for success (`created`, `queued`, `running`,
  `completed`) and provider failure (`created`, `queued`, `running`, `failed`).
  Tests now explicitly verify provider execution happens only after `running`
  is persisted, `TranslationOutput` is persisted before `completed`, no output
  is created on provider failure, and the original provider error is rethrown
  unchanged. No production behavior, retry, queue runtime, timeout,
  cancellation, metrics, HTTP, provider behavior, or persistence format changed.
- Phase 2P WP3 Failure Execution Lifecycle: verified provider execution
  failures now use the persisted `created`, `queued`, `running`, and `failed`
  lifecycle introduced by WP2. The failed state is persisted after the provider
  throws, no `TranslationOutput` is created on failure, the original provider
  exception is rethrown unchanged, and provider invocation count remains
  unchanged. No retry, timeout, queue runtime, error mapping, metrics, HTTP, or
  provider behavior was added.
- Phase 2P WP2 Success Execution Lifecycle: updated
  `TranslationCommandService` successful provider execution orchestration to
  persist `TranslationExecution` transitions in `created`, `queued`, `running`,
  and `completed` order. Provider resolution, provider invocation input,
  invocation count, `TranslationOutput` persistence before completion, and
  failure persistence behavior remain unchanged. No queue runtime, retry,
  timeout, cancellation, metrics, HTTP, or provider behavior was added.
- Phase 2P WP1 Extend Translation Execution Status: updated the
  `TranslationExecution` domain lifecycle to support explicit `created`,
  `queued`, `running`, `completed`, and `failed` statuses, added the `queue()`
  transition method, preserved explicit `start()`, `complete()`, and `fail()`
  behavior, and added focused domain coverage for the new queued/running
  lifecycle and deterministic rejection of unsupported legacy statuses. No
  application orchestration, provider execution, HTTP, retry, queue runtime,
  timeout, cancellation, or metrics behavior was added.
- Phase 2O WP7 Documentation and Closeout: completed Production Gemini
  Translation Execution documentation and closeout. Added the concrete
  `GeminiTranslationExecutionProvider` production adapter for Translation
  Execution, wired production composition to create `GeminiClient`, wrap it in
  the Gemini execution provider, register it as `gemini`, and keep `gemini` as
  the default production provider when `TRANSLATION_PROVIDER` is unset. Test and
  supplied-provider composition continues to use
  `FakeTranslationExecutionProvider` without invoking the Gemini production
  path. Focused unit, composition, vertical integration, and error integration
  coverage now verifies request and response mapping, provider wiring, default
  `gemini` resolution, fake-provider isolation, successful
  `TranslationOutput` persistence and completed execution lifecycle, failed
  execution persistence, no output on provider failure, and unchanged
  `GeminiHttpError` propagation at the application boundary. No retry, timeout,
  streaming, metrics, logging, fallback, HTTP API, persistence schema, frontend
  behavior, or real Gemini API validation was added.
- Phase 2N WP5 Failure Mapping and Closeout: completed Gemini Translation
  Execution Provider closeout, including stable `GeminiHttpError` mapping for
  Gemini HTTP 400, 401, 403, 429, 5xx, and generic HTTP failures while
  preserving the existing exception propagation lifecycle and explicit invalid
  response errors. Documented that production Translation Command composition
  now supports the concrete `GeminiTranslationExecutionProvider` backed by
  `GeminiClient`, registers `gemini` through
  `TranslationExecutionProviderResolver`, uses `GEMINI_API_KEY` and
  `SAVED_RETRANSLATION_GEMINI_MODEL`, and has fake HTTP vertical integration coverage proving
  provider dispatch, `TranslationOutput` persistence, completed and failed
  execution lifecycles, and no real Gemini API call during automated tests.
  Fake provider and fake resolver coverage remains supported. Real Gemini API
  validation still requires configured credentials and remains outside
  automated closeout.
- Phase 2M WP4 Documentation Closeout: completed Runtime Provider Resolution
  documentation in README and ROADMAP, marking Phase 2M complete and recording
  the delivered `TranslationExecutionProviderResolver` runtime boundary,
  resolver-backed `TranslationCommandService` execution, default provider
  behavior, deterministic unknown-provider failure lifecycle, current supported
  provider keys (`fake` for supplied fake/test execution providers and `gemini`
  for the current production runtime wrapper), and current limitation that no
  additional real provider implementations, fallback, health checks, frontend
  provider controls, HTTP API changes, or retry policy changes were added.
  Focused regression validation covered the fake resolver, Translation Command
  service execution, production composition wiring, and production HTTP
  vertical integration. No production code changed.
- Phase 2L WP7 Documentation and Closeout: completed Execution Reliability
  documentation in README and ROADMAP, marking Phase 2L complete and recording
  the delivered `RetryPolicy` abstraction, `TranslationExecutionRunner`, retry
  execution, exhausted retry lifecycle, production composition wiring, and
  production vertical integration coverage. Current production composition uses
  the default `RetryPolicy(maxRetries = 0)`, so provider execution attempts
  remain exactly one on failure. Backoff, sleep, timers, scheduling, queue or
  worker execution, retry metrics, retry persistence, timeout handling,
  cancellation, environment-configurable retry policy, and HTTP contract changes
  remain future work.
- Phase 2L WP6 Vertical Integration: added production HTTP vertical
  integration coverage for the translation execution reliability path through
  `TranslationCommandController`, `TranslationCommandService`,
  `TranslationExecutionRunner`, `ProductionTranslationExecutionProvider`,
  provider resolution, and repository persistence. The tests prove successful
  execution resolves and executes the provider once, persists one output,
  completes once, preserves explicit and omitted `providerKey` attribution, and
  does not forward `providerKey` into resolved provider input. Provider failure
  coverage proves the default production retry policy remains `maxRetries = 0`,
  provider attempts remain exactly one, failed execution persistence happens
  once, no output or completed state is persisted, fallback provider execution
  does not occur, the original provider error is preserved at the application
  boundary, and the existing generic HTTP 500 contract is unchanged.
- Phase 2L WP5 Composition Wiring: wired production translation command
  composition to create the default `RetryPolicy`, build a
  `TranslationExecutionRunner` with the `TranslationRepository`,
  production `TranslationExecutionProvider`, and default policy, and inject the
  runner into `TranslationCommandService`. The default policy remains
  `maxRetries = 0`, so production execution still performs no retries and no
  retry runtime configuration, backoff, timers, queue, logging, metrics, or
  persistence behavior was added.
- Phase 2L WP4 Exhausted Retry Failure Semantics: verified
  `TranslationExecutionRunner` keeps executions active through retryable
  intermediate provider failures, persists exactly one failed execution only
  after retry exhaustion, creates no `TranslationOutput`, writes no completed
  state, stops at `1 + maxRetries` provider attempts, and rethrows the final
  provider error by identity. Default `maxRetries = 0` behavior remains a
  single provider attempt followed by the existing failed-execution persistence.
- Phase 2L WP3 Retry Execution: added retry execution inside
  `TranslationExecutionRunner` using the injected `RetryPolicy`, retrying
  provider execution until success or retry exhaustion, calling `nextDelay()` for
  future compatibility without sleeping or scheduling, persisting exactly one
  `TranslationOutput` and one completion on success, and marking the execution
  failed only after retries are exhausted. The default production policy remains
  `maxRetries = 0`, so production runtime behavior is unchanged unless a
  different policy is explicitly injected. No backoff, timers, scheduling,
  queue, worker, cancellation, retry metrics, retry persistence, HTTP, or
  composition behavior was added.
- Phase 2L WP2 TranslationExecutionRunner: extracted provider execution
  orchestration from `TranslationCommandService` into a dedicated
  application-layer runner that owns provider invocation, `TranslationOutput`
  creation, completion persistence, and failure persistence while accepting the
  new `RetryPolicy` as configuration only. `TranslationCommandService` now
  delegates provider execution through the runner, preserving the existing
  execution lifecycle, domain-event publication, repository behavior, and
  no-retry default runtime semantics. No retry loop, backoff, scheduling,
  queue, worker, HTTP, repository, provider, or composition wiring behavior was
  added.
- Phase 2K WP6 Documentation and Regression Closeout: completed Production
  Translation Runtime documentation, marked Phase 2K completed in the roadmap,
  documented Phase 2L Execution Reliability as the next phase, and recorded the
  completed production runtime port, resolver-backed runtime adapter,
  production composition wiring, runtime vertical integration, and runtime
  failure lifecycle. Focused regression validation covered the production
  runtime port, adapter, composition root, command-service execution, and
  vertical integration. No production runtime behavior changed.
- Phase 2K WP5 Runtime Failure Lifecycle: added Translation Command runtime
  failure handling so provider execution errors persist the created
  `TranslationExecution` as `failed`, skip `TranslationOutput` creation, avoid
  completed-state writes, and rethrow the original provider exception. Focused
  unit and production vertical integration coverage proves provider execution
  is called once, the HTTP error response keeps the existing generic internal
  error contract, repository state retains the failed execution, and successful
  production runtime persistence remains covered. No retry, timeout,
  cancellation, error classification, logging, metrics, provider resolver,
  composition, or HTTP API contract behavior was added.
- Phase 2K WP4 Production Runtime Vertical Integration: added production
  vertical integration coverage proving `POST /api/translation-executions`
  uses production composition to build the runtime execution adapter, resolves a
  deterministic translation provider through the provider resolver exactly once,
  executes the resolved provider exactly once without passing `providerKey` into
  provider input, persists exactly one `TranslationOutput`, completes the
  `TranslationExecution`, preserves explicit `providerKey`, and keeps omitted
  `providerKey` as `undefined`. No production runtime, provider resolver,
  provider implementation, HTTP API, repository, domain, retry, timeout, or
  failure-lifecycle behavior changed.
- Phase 2K WP3 Production Runtime Composition Wiring: wired production
  Translation Command composition to build a production translation execution
  provider from the existing translation provider resolver and inject only that
  execution provider into `TranslationCommandService`. Focused composition
  coverage verifies the resolver-to-runtime-provider dependency, preserves
  supplied fake execution providers for fake/test composition, and keeps saved
  transcript retranslation resolver wiring unchanged. No command service,
  runtime adapter, provider resolver, HTTP API, repository, domain, retry,
  timeout, or failure-handling behavior changed.
- Phase 2J WP5 Translation Execution Vertical Integration: added production
  vertical integration coverage proving `POST /api/translation-executions`
  executes the production-composed `FakeTranslationExecutionProvider`, creates
  exactly one `TranslationOutput` with `[fake] ${sourceText}` text, completes
  the persisted execution, preserves explicit `providerKey` metadata unchanged,
  and keeps omitted `providerKey` as `undefined`. No application, domain,
  repository, composition root, HTTP API, provider resolution, dispatcher,
  saved-transcript retranslation, persistence schema, or fake-provider behavior
  changed.
- Phase 2J WP4 Production Composition Wiring: wired production composition to
  instantiate and inject the existing `FakeTranslationExecutionProvider` into
  `TranslationCommandService`, with focused composition coverage for default
  provider injection, supplied-provider execution wiring, and preserved
  provider-omitted dispatcher behavior. No provider resolution, HTTP API,
  repository, domain model, saved-transcript retranslation, dispatcher
  implementation, or fake-provider behavior changed.
- Phase 2J WP3 Translation Execution Provider Orchestration: added
  application-layer `TranslationCommandService` orchestration for an explicitly
  injected `translationExecutionProvider`, persisting the created execution,
  invoking the provider once with source text, optional source language,
  target language, and optional provider key unchanged, creating a
  `TranslationOutput` from the provider-returned translated text, and then
  persisting the execution as completed. Existing production composition,
  dispatcher behavior, provider resolution, persistence adapters, HTTP behavior,
  saved-transcript retranslation, and fake provider implementation were left
  unchanged.
- Phase 2I WP6 Regression Validation and Closeout: completed documentation
  closeout for Translation Execution Dispatcher, marking Phase 2I complete and
  documenting `TranslationExecutionDispatcher` as the awaited asynchronous
  application-layer execution orchestration port invoked after
  `TranslationExecution` persistence. Current production composition injects
  `FakeTranslationExecutionDispatcher`, which records dispatches only; no
  provider execution, queue, scheduler, worker, background execution,
  translation, retry, persistence, execution-state update, or
  `TranslationOutput` creation occurs. `providerKey` remains metadata only,
  explicit keys are preserved, omitted keys remain `undefined`, the dispatcher
  does not resolve providers, and Saved Transcript Retranslation remains the
  only request-scoped provider-resolution flow. Focused regression validation
  covered the dispatcher port, fake dispatcher, command-service dispatch
  orchestration, composition wiring, HTTP translation command, vertical
  integration, provider metadata preservation, domain-event composition, and
  Saved Transcript Retranslation composition. No production code changed.
- Phase 2H WP7 Regression Validation and Closeout: completed documentation
  closeout for Translation Command provider attribution, marking Phase 2H
  complete and documenting that `TranslationExecution.providerKey` is optional
  metadata only, omitted keys remain `undefined`, Translation Command never
  resolves, looks up, normalizes, defaults, or falls back providers, invalid
  provider names are intentionally not validated beyond domain string/non-blank
  validation, and Saved Transcript Retranslation remains the only production
  provider-resolution path. No production behavior, domain behavior,
  repository behavior, provider resolution, persistence, saved-transcript,
  frontend, or runtime behavior changed.
- Phase 2H WP6 Translation Command Provider Metadata Vertical Integration:
  added focused integration coverage proving `POST /api/translation-executions`
  carries optional `providerKey` metadata through production composition from
  HTTP, controller, application service, domain construction, and repository
  persistence unchanged, including omitted-key `undefined` semantics. No
  provider resolution, provider lookup, fallback, normalization, validation,
  persistence migration, HTTP behavior, repository behavior, saved-transcript,
  frontend, or production code changed.
- Phase 2H WP5 Translation Command Production Composition:
  added focused production-composition coverage proving the composed
  Translation Command Controller forwards optional `providerKey` metadata
  unchanged into `TranslationCommandService.createTranslationExecution`,
  preserves omitted-key `undefined` semantics, and does not invoke provider
  resolution for the translation command path. No provider lookup, HTTP,
  persistence, saved-transcript, frontend, or domain behavior was changed.
- Phase 2H WP4 Translation Command HTTP API Provider Metadata Input:
  documented focused HTTP-boundary coverage proving
  `POST /api/translation-executions` forwards optional `providerKey` metadata
  unchanged into `TranslationCommandController.createTranslationExecution`,
  preserves omitted-key `undefined` semantics, and does not validate invalid
  provider metadata at the HTTP layer. No provider resolution, persistence,
  saved-transcript, frontend, or environment behavior was changed.
- Phase 2H WP3 Translation Command Controller Provider Metadata Input:
  kept the non-HTTP Translation Command Controller create-execution boundary as
  an unchanged pass-through into `TranslationCommandService.createTranslationExecution`,
  with focused coverage proving optional `providerKey` metadata is forwarded
  exactly as received, omitted keys are not defaulted, invalid values are not
  validated by the controller, and service results/errors remain unchanged. No
  HTTP API, repository, provider resolver, provider registry, composition,
  persistence, saved-transcript, provider implementation, or frontend behavior
  was changed.
- Phase 2H WP2 Translation Command Service Provider Metadata Input:
  made the Translation Command Service create-execution path explicitly forward
  optional `providerKey` metadata into the Translation Execution domain model,
  preserving omitted-key behavior and leaving provider-key validation solely in
  the domain. No HTTP API, repository, provider resolver, provider registry,
  composition, persistence, saved-transcript, or frontend behavior was changed.
- Phase 2H WP1 Translation Execution Provider Metadata Domain Contract:
  added optional immutable `providerKey` attribution to the Translation
  Execution domain model with string/non-blank validation, omitted-key support,
  and lifecycle transition preservation. No persistence, HTTP API, provider
  resolution, composition, provider implementation, read-model, repository, or
  saved-transcript retranslation behavior was changed.
- Phase 2G WP7 Regression Validation and Closeout: completed documentation
  closeout for Request-Scoped Provider Selection, marking Phase 2G complete and
  documenting saved-transcript HTTP `providerKey` support, explicit request
  override behavior, environment-backed default provider selection when omitted,
  existing unknown-provider registry error propagation, and no provider
  fallback semantics. No production behavior changed and automated regression
  validation is deferred to manual execution.
- Phase 2G WP6 HTTP Integration Provider Selection: added production HTTP
  integration coverage proving saved-transcript retranslation performs
  request-scoped provider selection from the optional request `providerKey`,
  where explicit `fake` overrides configured `TRANSLATION_PROVIDER=gemini`,
  omitted provider selection resolves the configured Gemini default, and an
  unknown provider propagates the existing registry error without fallback,
  provider execution, SDK use, or translation command persistence. No
  production code changed.
- Phase 2G WP5 Request-Scoped Provider Resolution Wiring: moved production
  saved-transcript retranslation provider selection from startup-time provider
  injection to a request-scoped resolver dependency, forwarding explicit and
  omitted `providerKey` values into the existing translation provider
  resolution composition with the shared configuration object, preserving
  default-provider ownership, exact resolved-provider pass-through,
  resolution-error propagation, and existing successful persistence/event
  ordering with no HTTP parsing, resolver, registry, provider implementation,
  persistence schema, retry, fallback, or frontend behavior changes.
- Phase 2G WP4 HTTP API Provider Selection Input: extended the saved
  transcript retranslation HTTP request boundary to accept optional
  `providerKey` and forward it unchanged to the existing service/controller
  call while preserving omitted-key behavior and avoiding resolver,
  composition, provider, persistence, retry, fallback, environment, frontend,
  and domain changes.
- Phase 2G WP3 Saved Transcript Retranslation Provider Selection Input:
  threaded optional `providerKey` input through the production saved-transcript
  retranslation composition boundary into the existing translation provider
  resolution composition, preserving configuration-object forwarding, resolved
  provider identity, default-provider resolver ownership, and unchanged
  resolution error propagation with no HTTP, provider, registry, resolver,
  persistence, retry, environment-variable, frontend, or Gemini behavior
  changes.
- Phase 2G WP1 Resolver Explicit Provider Selection: extended
  `TranslationProviderResolver` request-level selection so an optional explicit
  `providerKey` takes precedence over `configuration.defaultProviderKey`,
  validates explicit keys for string type and blankness only, delegates exact
  provider lookup and unknown-provider errors unchanged to
  `TranslationProviderRegistry`, and preserves configuration-driven default
  resolution with no HTTP, composition root, provider implementation,
  persistence, frontend, retry, fallback, or runtime provider management
  changes.
- Phase 2F WP7 Translation Provider Configuration closeout: completed the
  focused regression verification for configuration-driven provider resolution,
  documenting that the environment-backed configuration factory selects the
  default provider key, defaults to `gemini` when `TRANSLATION_PROVIDER` is
  unset, preserves explicit `TRANSLATION_PROVIDER=gemini`, and passes the
  shared configuration object through production composition into
  `TranslationProviderResolver`. Production composition now owns creation of the
  shared provider configuration, the resolver consumes the configuration object,
  composition no longer extracts `defaultProviderKey`, and explicit Gemini
  production HTTP integration was verified through fake GoogleGenAI only with
  no real Gemini API calls and no HTTP, persistence, domain, frontend, retry, or
  fallback behavior changes.
- Phase 2F WP6 Configuration-driven Provider Resolution Integration
  Verification: extended production saved-transcript HTTP integration coverage
  to prove explicit `TRANSLATION_PROVIDER=gemini` is consumed by the shared
  translation provider configuration factory, passed as the full configuration
  object into provider-resolution composition, resolved once through
  `TranslationProviderResolver` and `TranslationProviderRegistry`, injected into
  `SavedTranscriptRetranslationService`, invoked once through the Gemini
  provider and fake GoogleGenAI client, and preserves the existing `201`
  response and translation persistence shape with no real Gemini API call or
  production code changes.
- Phase 2F WP5 Saved Transcript Retranslation Composition Migration:
  moved saved-transcript provider-resolution composition ownership fully to the
  shared translation provider configuration object by removing the composition
  guard that extracted `configuration.defaultProviderKey`, keeping production
  saved-transcript composition passing the configuration object into provider
  resolution and resolving through `TranslationProviderResolver` with no HTTP,
  persistence, provider, Gemini, retry, fallback, frontend, or API behavior
  changes.
- Phase 2F WP4 Translation Provider Configuration HTTP/API Integration:
  moved the production HTTP saved-transcript translation provider-resolution
  handoff to pass the shared translation provider configuration object instead
  of an extracted provider key, updated the provider-resolution composition
  adapter to construct the configured resolver from that object while
  preserving its registered-default guard, and verified the HTTP path still
  resolves once, invokes the selected provider once, returns the same response
  shape, and preserves persistence behavior with no Gemini, frontend, retry, or
  fallback changes.
- Phase 2F WP3 Translation Provider Resolver Configuration Integration:
  refactored the translation provider resolver constructor to consume
  `configuration.defaultProviderKey` instead of a direct `defaultProviderKey`
  option, removed construction-time default-provider registry existence
  checks from the resolver, adapted the existing provider-resolution
  composition boundary to pass a configuration object while preserving its
  default-provider guard, and preserved explicit provider resolution,
  configured default resolution, registry error propagation, no-fallback
  behavior, provider identity, immutability, and
  non-HTTP/non-Gemini/non-persistence behavior.
- Phase 2F WP2 Translation Provider Configuration Composition: wired the
  environment-backed translation provider configuration into production
  saved-transcript provider composition so provider resolution receives
  `configuration.defaultProviderKey` instead of a hardcoded default, while
  keeping registry, resolver, service API, HTTP API, Gemini provider behavior,
  translation logic, retry, fallback, runtime provider switching, database, and
  frontend behavior unchanged.
- Phase 2F WP1 Translation Provider Configuration: added a standalone
  immutable environment-backed configuration factory for selecting the default
  translation provider key from `TRANSLATION_PROVIDER`, defaulting to `gemini`
  when unset and preserving configured provider keys without validating provider
  existence. Resolver, registry, production composition, HTTP API, Gemini
  provider behavior, runtime provider switching, fallback, retry, SDK loading,
  and real Gemini API usage remain unchanged.
- Phase 2E WP7 closeout and final regression: completed the full Translation
  Provider architecture regression suite for the registry, resolver,
  composition, saved-transcript integration, and production Gemini HTTP path.
  The suite verified the default Gemini provider resolution path through the
  controller, saved-transcript retranslation service, resolver, registry,
  Gemini provider, Gemini client adapter, and fake GoogleGenAI client with one
  resolver call, one registry lookup, one provider invocation, one
  `generateContent` call, no skipped tests, no real Gemini API call, and no
  HTTP, persistence, controller, retry, fallback, provider interface, frontend,
  or production behavior change. Phase 2E is complete.
- Phase 2E WP6 Provider Resolution End-to-End Verification: extended the
  production saved-transcript HTTP end-to-end test to prove the composed Gemini
  provider is registered, resolved once with no provider key through the
  configured default provider, injected unchanged into the retranslation
  service, invoked once with unchanged inputs, and forwarded through the Gemini
  client adapter to a fake GoogleGenAI `generateContent` call exactly once while
  preserving the Phase 2D `201` response body and persisted request,
  execution, and output state with no real Gemini API call or production code
  behavior change.
- Phase 2E WP5 Saved Transcript Provider Resolution Integration verification:
  added focused production HTTP integration coverage proving saved-transcript
  retranslation resolves the configured Gemini provider through the translation
  provider resolver and registry, injects that resolved provider into the
  application service, invokes provider translation and fake GoogleGenAI
  content generation exactly once, and preserves the existing API response
  contract with no runtime provider switching, fallback, retry, persistence,
  controller, UI, or real Google API behavior changes.
- Phase 2E WP4 Saved Transcript Provider Resolution Integration: activated
  translation provider resolution in production saved-transcript retranslation
  composition by registering the composed Gemini provider, resolving the
  configured default provider once during composition, and injecting that
  resolved provider unchanged into the application service. No HTTP, provider,
  persistence, retry, fallback, runtime switching, UI, or real Gemini API
  behavior was introduced.
- Phase 2E WP3 Translation Provider Resolution Composition: added a focused
  infrastructure composition factory that assembles the translation provider
  registry and resolver through the existing WP1/WP2 factories, verifies
  default and explicit provider resolution, preserves provider identity and
  exact provider-key behavior, and remains inactive in production runtime flows
  with no real Gemini API calls.
- Phase 2E WP2 Translation Provider Resolver: added a standalone
  infrastructure resolver that selects an explicitly requested translation
  provider key or the configured registered default provider key, delegates
  exact provider lookup to the registry without normalization, validates
  dependencies and resolve options synchronously, and exposes a frozen
  `resolve`-only API. The resolver returns provider instances without invoking
  translation and does not add runtime composition, HTTP wiring, fallback,
  retries, SDK construction, environment loading, persistence, or real Gemini
  API behavior.
- Phase 2E WP1 Translation Provider Registry: added a standalone
  infrastructure registry contract for validating and looking up registered
  translation providers by exact provider key, with frozen `get`/`has`/`list`
  API surface and focused unit coverage. Resolver, runtime, metadata,
  production composition wiring, HTTP wiring, and Gemini provider registration
  remain deferred.
- Phase 2D WP7 final verification and closeout: completed the focused
  regression pass for WP1-WP6 production Gemini saved-transcript translation,
  confirming provider contract behavior, Gemini client adapter forwarding,
  GoogleGenAI construction, production composition, and HTTP end-to-end flow
  with fake SDK clients only. Phase 2D is complete with no real Gemini API
  execution, public API changes, persistence changes, HTTP contract changes,
  React changes, retry behavior, streaming behavior, or production behavior
  expansion.
- Phase 2D WP6 end-to-end Gemini translation flow verification: added focused
  integration coverage proving the production saved-transcript HTTP command path
  composes through the controller, application service, production Gemini
  provider, client adapter, and fake Google GenAI SDK client, invoking
  `generateContent` exactly once while forwarding the configured model, prompt
  context, transcript text, source language, and target language without real
  Gemini API calls or production behavior changes.
- Phase 2D WP5 production Gemini integration verification: added focused
  integration coverage for the saved-transcript HTTP path through production
  Gemini composition into the Google GenAI SDK adapter shape, including
  dependency invocation counts, request shape, result mapping, and exact
  `generateContent` failure propagation with no retry or fallback behavior.
- Phase 2D WP4 production Gemini saved-transcript provider activation: added
  production composition-root wiring from Gemini environment, GoogleGenAI SDK
  client, Gemini client adapter, and Gemini saved-transcript provider
  composition into the saved-transcript re-translation application service,
  with focused unit coverage and no HTTP, persistence, provider, prompt, retry,
  fallback, or UI behavior changes.
- Phase 2D WP3 GoogleGenAI construction and Gemini saved-transcript provider
  composition: added focused official `GoogleGenAI` SDK client construction,
  a production-facing Gemini saved-transcript translation composition factory
  that reuses the WP1 provider plus WP2 environment and client adapter, and
  focused unit coverage. Production application composition-root wiring,
  HTTP activation, UI wiring, live-session flow, persistence, and real Gemini
  network flow remain deferred.
- Phase 2D WP2 Gemini client adapter and environment configuration: added a
  frozen infrastructure adapter that delegates directly to
  `client.models.generateContent(request)` without transformation, retry,
  timeout, logging, or SDK construction, plus deterministic `GEMINI_API_KEY`
  and `SAVED_RETRANSLATION_GEMINI_MODEL` validation for future saved-transcript provider
  composition. This does not wire the adapter into production composition,
  HTTP endpoints, application services, UI, persistence, or runtime
  translation flow.
- Phase 2D WP1 Gemini saved-transcript translation provider contract: added a
  Gemini-specific infrastructure factory with injected client, model, and prompt
  builder dependencies, deterministic request construction, response
  normalization, and focused error boundaries. This does not add real Gemini API
  integration, production composition wiring, environment configuration, SDK
  initialization, or network calls.
- Phase 2C Saved Transcript Re-translation closeout: marked the capability as
  completed after focused provider, application service, composition, HTTP,
  event-ordering, failure-boundary, immutability, and export-surface
  verification. The completed boundary remains deterministic and scoped; no
  real external provider, UI, retry, rollback, transaction, compensation, or
  deployment behavior is included.
- Phase 2C WP1 completion pass for saved-transcript re-translation
  consistency: the application service now persists the `TranslationOutput`
  before marking the `TranslationExecution` as `completed`, so output
  persistence failure and output-created event publication failure cannot leave
  a falsely completed execution. The successful orchestration order is now
  request creation, execution creation, execution start, provider invocation,
  output creation, then execution completion. Existing repository-before-event
  publication semantics remain unchanged: repository writes and domain event
  publication are not atomic, so a completion event publication failure may
  still leave both the completed execution and output persisted. No rollback,
  retry, transaction, or compensation mechanism was introduced.
- Phase 2C WP4 Saved Transcript Re-translation HTTP API: added
  `POST /api/saved-transcripts/:sessionId/translations` with a request body
  containing `sourceLanguageCode` and `targetLanguageCode`, returning `201`
  with the serialized `request`, final `execution`, and `output` from the
  saved-transcript re-translation application service. The endpoint returns
  `503` when the optional re-translation capability is not configured. No real
  translation provider, React UI, live-session integration, or fake provider
  production wiring was added.
- Phase 2C WP3 Saved Transcript Re-translation Application Service:
  resolves canonical saved source transcript text from legacy SessionRecord
  detail, orchestrates native TranslationRequest / TranslationExecution /
  TranslationOutput creation through the command service, persists successful
  provider results and failed provider executions deterministically, and keeps
  HTTP, UI, and real provider integration out of scope.
- Phase 2C WP2 Saved Transcript Translation Provider Port: added a
  provider-neutral saved-transcript translation application port and
  deterministic fake adapter supporting configured success, rejected failure,
  synchronous throw, and deferred completion without real provider or network
  integration.
- Phase 2C WP1 Translation Persistence Foundation: repository queries for
  requests by session, executions by request, and outputs by session/request
  while preserving in-memory instance isolation and multiple output versions.
- Phase 2B-4 WP9 Translation Domain Event end-to-end integration coverage for production composition routing, lifecycle, and failure propagation.
- Phase 2B-4 WP8 Translation Domain Event handler factory with safe default no-op handlers.
- Phase 2B-4 WP7 Translation Domain Event infrastructure composition in the production application dependency graph.

## Phase 2A Foundation Completed

Phase 2A closes the foundation milestone for Live Translate. The core realtime translation workflow, transcript lifecycle, session history, saved-session export, and the first connection resilience slice are now documented as complete for the Phase 2 foundation.

This milestone intentionally keeps durable storage deferred. History remains memory-only, backend persistence is not introduced, and the next milestone is Phase 2B.

## v0.6.0 - Connection Resilience Phase 1

### Added

- Failure Classification
- Retry Policy
- Reconnect Controller
- LiveSession Failure Signal Integration
- Controlled `unexpected_close` reconnect
- Failure-State Mapping
- Manual Recovery UX
- Retry Exhaustion UX

### Improved

- Stable frontend failure handling
- Safer reconnect orchestration
- Better session lifecycle consistency
- Clearer failure UX
- Better unit/E2E coverage

### Deferred

These items are intentionally deferred:

- `token_expired` reconnect
- network reconnect
- provider reconnect
- microphone reconnect
- proactive token refresh

### Notes

- Connection Resilience is now partially implemented.
- Only `unexpected_close` supports controlled reconnect.
- Phase 2 overall remains In Progress.

## v0.5.0 - Phase 2 Foundation

### Added

- Better Transcript Handling
- Transcript Export
- Audio Input Device Selection
- Session Lifecycle Specification
- Capability-based Phase 2 planning guidance

### Changed

- Transcript state moved into dedicated transcript utility
- Transcript export added for current-session TXT/SRT/VTT
- Audio input device selection added for microphone selection
- Phase 2 planning now groups related work by capability

### Notes

- Output device selection remains future/browser-limited
- Auto Reconnect and Token Refresh are not implemented yet
- SRT/VTT timing is approximate frontend observation timing
## WP4 Subtitle Cue UI

- Live translation now renders one bilingual row per final Cue with
  session-relative timecodes and a single trailing partial preview.
- History and reload prefer persisted final Cues and retain the legacy transcript
  reading view when no Cues are available.
- Pause and Resume preserve the Cue list; Stop preserves the flushed final Cue
  list and ignores late partial UI updates.
- Live subtitle scrolling follows the latest Cue until the user scrolls away;
  `回到最新字幕` restores follow mode.
## Unreleased

- Added the WP1 meeting summary pipeline for ordered Final Subtitle Cues,
  configurable chunking, Gemini Flash Lite chunk summaries, and deterministic
  structured merging.
- Session share tokens are now persisted to `DATA_DIR/session-shares.json` by
  default, with `SESSION_SHARES_FILE` as an override, so existing share links
  remain valid after backend restart.
# Unreleased

- Reorganized frontend capability code under `src/features/` while keeping
  route entry points under `src/pages/`; added the missing DLQ page mounting for
  `#dead-letter-queue` without changing API or queue behavior.

- 修正會議紀錄匯出只使用部分 Final Cue，導致下載的 TXT／字幕內容少於畫面顯示內容的問題。TXT 現在會保留整場 durable transcript；不完整的 Cue 會安全回退至逐字稿匯出。

- 更新唯讀 Meeting Viewer，改為截圖風格的滿版白底字幕工作區，只保留 Header、會議名稱與即時字幕，並使用板岩藍強調色。

- 修正長會議即時字幕在部分字幕完成潤飾後隱藏其他已錄製內容的問題。潤飾結果現在只覆蓋相同 Cue，尚未潤飾的原始字幕仍會完整顯示。

- 修正即時字幕與潤飾競爭問題。錄音期間不再啟動潤飾，改於工作階段停止或會議完成後送出；潤飾等待期間保留原始字幕，且不再讓字幕列持續顯示潤飾中的底色。

- 新增獨立 `#translation-history` 翻譯紀錄頁。紀錄列表改用卡片式工作區，選取紀錄後可透過「紀錄／原文／翻譯／匯出」小目錄切換內容；既有 `#history` 連結會相容導向新頁面。
- 會議管理中的已完成會議入口統一導向 `#translation-history`，並保留舊 Meeting Workspace history tab 作為相容功能。

- Completed Session sharing handoff: Viewer SSE snapshots now use the same
  sanitized read model as detail reads, share URLs use SPA hash routes, and
  token/code viewers support reconnect-safe updates.
- Added owner share management with expiry, local QR generation, short codes,
  listing, and revocation.
- Added named Session creation and explicit single-instance start blocking.
# Unreleased

- 修正即時逐字稿將逐字累積的 final 文字重複追加。現在同一句的累積更新會覆蓋前一版本，完整句子與真正的新句子仍會保留為獨立紀錄。

- Added meeting-scoped glossary snapshots. Users can select live glossary terms before starting a meeting; the snapshot is reused across meeting segments, reconnects, and saved transcript re-translation without following later global glossary changes.
- 修正 Meeting 分享設定頁重新整理或重新進入後分享連結消失的問題。分享服務現在持久化短碼（仍只保存 token hash），管理端可重建短碼 URL 與 QR Code；匿名分享回應不暴露短碼，舊資料會在沒有可顯示連結時補建新的分享。
- P1-A2：新增 owner-scoped `meeting_events` durable event history；finalized Meeting Cue 以 event identity 去重並提供 cursor replay，Viewer reconnect 會補抓遺失事件。
# Unreleased

- Added minute-bucket Supabase observability metrics, safe structured logging, readiness dependency hook, and share-scoped Viewer telemetry validation.
- Completed P1-B observability wiring for worker/runtime lifecycle, Gemini provider status and latency metrics, Viewer reconnect/gap/duplicate/replay telemetry, and best-effort production metric persistence.
## Unreleased

- Moved background translation worker scheduling from Vercel Cron to a GitHub Actions workflow running every five minutes, with manual dispatch and concurrency protection.
- Added visible queued and processing feedback for background translation, including last-update time, automatic refresh guidance, and a five-minute delay notice.
- Issue #33: added account role/status metadata, disabled-account enforcement, meeting membership schema, RLS helpers, and controlled super-admin bootstrap.
## 2026-09-14
- 修正未授權 Google 個人帳號登入後的死循環；前端現在顯示目前 email 與拒絕原因，並由使用者明確操作切換帳號，不再自動反覆登入或登出。
## Unreleased

- Completed Issue #33 member recording permission controls, super-admin audit log query API, and account management audit view.
- Added P7 asynchronous cloud Meeting export lifecycle: canonical server-side TXT/SRT/VTT generation from persisted Final Cues, idempotent `export_artifacts`, private `meeting-exports` Storage, signed download URLs, `export_jobs` worker retries/dead-letter handling, deletion cleanup, and cloud polling UI. Local browser-only export remains compatible.
## 2026-09-23

- Documented the GSK-04 Gemini credential boundary: Live token issuance uses only the recorder request key, with no dependency on the legacy profile credential API, stored credentials, or `GEMINI_API_KEY` fallback. Legacy APIs, `geminiCredentialApiClient`, `gemini_credentials`, and historical credential data remain a controlled compatibility layer and are not claimed deleted or reusable by Live. Non-Live backend Gemini workflows may keep an isolated environment key; secret-bearing values remain excluded from `no-store` responses, logs, metrics, and telemetry.
