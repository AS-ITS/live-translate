# Live Translate OpenSpec 盤點審查與規格基線準備

## 審查範圍與證據限制

- 審查日期：2026-10-13（Asia/Taipei）。
- 程式基線：Git HEAD `37b2d10`，加上盤點前已存在的 dirty working tree。
- 本次只進行程式、測試、文件、OpenSpec、Git 與已取得 GitHub metadata 的靜態審查。
- 本次未重跑 unit/integration/Playwright/cloud/real Gemini 測試，不將「測試檔存在」或「過去通過」當成當前 Production 驗證。
- OpenSpec 本機驗證：`openspec validate formalize-viewer-subtitle-font-size --strict` 通過。
- GitHub 狀態來自第一階段在同一盤點日成功取得的 `gh issue/pr list`；本次重試時 `api.github.com` 連線失敗，因此不宣稱此後無外部狀態變更。

### 審查用狀態語意

| 標記 | 本審查的意義 |
|---|---|
| `CONFIRMED_IMPLEMENTED` | 目前 source path 存在，且有對應 committed automated test 證據。只是 program-level 判定。 |
| `IMPLEMENTED_UNVERIFIED` | 程式已接線，但本次沒有目標環境的當前通過記錄。 |
| `KNOWN_DEFECT` | 已在明確環境中觀察到的失敗；必須限定對象與環境，不自動外推至 Production。 |
| `PLANNED` | 僅有規劃／Issue／任務，未有足夠的現行程式證據。 |
| `UNKNOWN` | 根因、環境狀態或實作邊界無法由現有證據確定。 |

缺陷觀察另用環境標籤：`CONFIRMED_PRODUCTION`、`CONFIRMED_PREVIEW`、`REPRODUCED_IN_TEST`、`SUSPECTED`、`NOT_VERIFIED`。前兩者須有部署 build 與重現紀錄；`REPRODUCED_IN_TEST` 不推論目前產品環境。Phase 3A 盤點沒有為 Rollover 或 Recording/Export 取得 `CONFIRMED_PREVIEW`／`CONFIRMED_PRODUCTION` 證據。

## 第一部分：Feature Matrix 逐項審核

### 審核結果總表

| 順序 | 模組 | 審核決議 | 經審核狀態 | 程式／測試證據 | 主要 commit SHA | 驗證環境／限制 |
|---|---|---|---|---|---|---|
| 1 | Meeting Lifecycle | 通過 | `CONFIRMED_IMPLEMENTED` at program level | `meetingCheckpointService.js`, `supabaseMeetingLifecycleService.js`, lifecycle v2 migration；`meetingCheckpointService.test.js`, `meetingLifecycleHttpApi.test.js`, migration tests | `2bdd676` lifecycle v2；`9d05c08` hardening；最新相關 `386e019` | Unit/integration 證據存在；Preview/Production RPC、lease/takeover 未在本次驗證 |
| 2 | Gemini Live Transcription / Translation | 有條件通過 | `IMPLEMENTED_UNVERIFIED` | `liveSession.js`, `liveTranscriptionSession.js`, `tokenService.js`; live session/failure/glossary tests | 最新相關 `9cc3d9f`；provider transition 測試基線含 `9cc3d9f` | Mock/unit 證據；真實 Gemini、token expiry、GoAway 未驗證 |
| 3 | PCM Queue / Audio Buffering | 通過 | `CONFIRMED_IMPLEMENTED` at program level | `audioCapture.worklet.js`, `audio.js`, `liveSession.js`; `audio.test.js`, `liveSessionProviderTransition.test.js` | `9cc3d9f` | Unit/mock 證據；Mac/Windows/Safari 真實麥克風、長時間壓力未驗 |
| 4 | Session Rollover / Reconnection | 分類已修正；環境驗收待補 | `IMPLEMENTED_UNVERIFIED`; provider rollover `NOT_VERIFIED`；#41 的 15 分鐘失敗線索 `SUSPECTED` | `reconnectController.js`, `providerRecoveryCoordinator.js`, `rolloverRecoveryCoordinator.js`; 對應 unit tests | `72fc700`, `57974bc` | Mock/unit 證據；real Gemini rollover `NOT_VERIFIED`；60-second WebM rotation 與 provider rollover 為不同實驗對象 |
| 5 | Viewer / WebRTC / Subtitle Sync | 有條件通過 | `IMPLEMENTED_UNVERIFIED`; Production 事故根因 `UNKNOWN` | `MeetingViewerPage.jsx`, `subtitleTransport.js`, `subtitleDataChannel.js`, Viewer state/replay tests與 E2E | `a28efa2`, `9d7187e`, `c2c0de4` | Mocked browser/program evidence；Production incident 缺成對 trace，10/50/100 peers 未驗 |
| 6 | OPFS / IndexedDB | 通過 | `CONFIRMED_IMPLEMENTED` at program level | `localMeetingStorage.js`, `localMeetingRecorder.js`, `localMeetingPersistence.js`; storage/recorder/reload tests | `9cc3d9f`, `e3194f0`, `57974bc` | Node/browser harness 證據；Preview 真機 quota/offline/crash 未驗 |
| 7 | Supabase / Cloud Sync | 有條件通過 | `IMPLEMENTED_UNVERIFIED` | Supabase repositories/RPC/migrations, `cloudSaveCoordinator.js`; cloud save/lifecycle migration tests | `ae68955`；基礎 `d65e7f5`, `031b407` | Repository/migration test evidence；當前 Preview/Production migration head、RLS、staging smoke 結果不明 |
| 8 | Glossary | 通過 | `CONFIRMED_IMPLEMENTED` at program level | glossary feature/UI/controller/Supabase adapter；revision/replacement/HTTP/E2E tests | `a915642`, `51f60c5` | Unit/integration/mocked E2E 證據；真實 Gemini instruction 品質與大規模詞彙未驗 |
| 9 | Recording / Export | 分類已修正；環境驗收待補 | `CONFIRMED_IMPLEMENTED` for current paths; isolated slice/rotation candidate `REPRODUCED_IN_TEST`; Production impact `NOT_VERIFIED` | recorder/local export/cloud export source；recorder/export/artifact tests | `9cc3d9f`, `e3194f0`, `9444eb0`, `fcad972` | Unit + Playwright Headless Chromium 149.0.7827.55/macOS；−25.33 ms rotation penalty 超過 20 ms gate；無 Preview/Production 重現 |
| 10 | Authentication / Administration | 有條件通過 | `IMPLEMENTED_UNVERIFIED` | `AuthGate.jsx`, `supabaseAuth.js`, access/admin/audit services, auth/account migrations and tests | `712e484`; account baseline PR #34 | Unit/integration/mocked E2E 證據；Preview/Production OAuth redirect、domain env、RLS 未驗 |
| 11 | UI / RWD / Fullscreen | 有條件通過 | `CONFIRMED_IMPLEMENTED` in mocked browser; real-device `IMPLEMENTED_UNVERIFIED` | Viewer page, preference helper, responsive CSS; preference unit and fullscreen/header E2E | `6bde950` | Playwright/mock evidence；iOS Safari、native fullscreen、physical touch comfort 未驗 |

### 審查通過項目

1. **Meeting Lifecycle**：程式、migration 與測試同時支持 transactional lifecycle、fence、idempotency 與 Segment boundary。「通過」僅限 program-level baseline。
2. **PCM Queue / Audio Buffering**：有界 queue、overflow/drop 計數、provider transition drain、AudioWorklet fallback 皆有程式與自動測試支持。
3. **OPFS / IndexedDB**：reserve/write/seal、immutable identity、reload reconciliation、secret projection 與 retention 的程式邊界已建立。
4. **Glossary**：CRUD/import/revision/replacement/Continue 邊界有程式與多層測試證據。

### 有條件通過項目

1. **Gemini Live**：允許移轉「程式契約」，不允許寫入真實 provider SLA 或長連線保證。
2. **Viewer / WebRTC**：允許收錄 protocol/state/ordering 現行契約；Production 事故保持 `UNKNOWN`。
3. **Supabase / Cloud Sync**：允許收錄 repository/RPC/idempotency 契約；不宣稱當前部署已同步。
4. **Authentication / Administration**：允許收錄 role/status/RLS 意圖與 server checks；部署 OAuth/env/RLS 仍待驗。
5. **UI / RWD / Fullscreen**：允許收錄 mock-browser 行為；真機與觸控不得標成 verified。

### 退回修正項目：Phase 3A 處置

1. **Session Rollover / Reconnection**：原矩陣的 product `KNOWN_DEFECT` 已移除。15 分鐘 provider rollover 問題僅保留為 #41 追蹤的 `SUSPECTED` 線索；real Gemini、Preview、Production 均 `NOT_VERIFIED`。60 秒 WebM rotation 不再放在 provider rollover 的缺陷證據。
2. **Recording / Export**：現行路徑保留 `CONFIRMED_IMPLEMENTED`（program level）；WebM 非初始 slice `EncodingError` 與 60 秒 rotation `−25.33 ms` penalty 保留為 `REPRODUCED_IN_TEST`，僅限 Phase A Headless Chromium/macOS。現行 Production 錄音／匯出是否受影響 `NOT_VERIFIED`。

### Issue／PR／實作／測試衝突審查

| 項目 | 證據 | 結論 |
|---|---|---|
| #35/#37/#38 已 closed，PR #39/#40 已 merged | 對應 Supabase/local-first/WebRTC/recording 程式確實存在 | 無直接衝突，但 closed/merged 不能證明 Preview/Production 驗收通過 |
| #41 仍 open | diagnostics 與 Phase A 實驗已提供部分證據，LAR-16～21 與 Gap Recovery 尚未完成 | 不可把 #41 所有需求當成 current implementation；15 分鐘 rollover 線索屬 `SUSPECTED`，並非已確認 Production 根因 |
| Viewer font-size OpenSpec tasks 0/7 | commit `6bde950` 已含 UI/helper/CSS/docs/tests | 這是「實作先於 OpenSpec 形式化」，不是程式不存在；也不允許無驗證全勾 |
| Production Viewer 問題 | Phase A 明記 `NOT CONFIRMED` | 保持 `UNKNOWN`，不建立虛構 root cause 或修復 spec |
| `docs/spec.md` 將 auth/history/export 列為 future | 目前 auth/history/export source/tests/migrations 已存在 | 舊文件過時；規格移轉後再同步，不以舊文件否定程式證據 |

## 第二部分：`formalize-viewer-subtitle-font-size` 衝突審查

### 七項 tasks 對照

| Task | 審查判定 | 目前證據 | 尚缺項目 | 勾選建議 |
|---|---|---|---|---|
| 1.1 契約與現有實作調和 | 部分滿足 | `6bde950` 僅修改 Viewer presentation/helper/CSS/docs/tests，未觸及 transport/replay modules；page-level state、fullscreen shell、reading-anchor dependencies 對齊 design | 本審查找到測試缺口，尚未有 apply 後的差異處理與最終 product diff 確認 | 現在不勾 |
| 1.2 preference helper 完整單測 | 部分滿足 | 已測 `large`、`small`、missing、invalid、normalized persistence | 未明確測 `medium` 寫讀；未測 `getItem`/`setItem` 抛錯或 storage unavailable | 現在不勾 |
| 2.1 三種尺寸、雙語、hidden inheritance、fullscreen、reload、reconnect | 部分滿足 | 已測 medium/large 雙語、CSS fullscreen、reload，reconnect 保留 visibility | 未完整測 small；未測隱藏 stream 期間改尺寸後再顯示；未在 native fullscreen 中驗尺寸；未在已選非預設尺寸後驗 reconnect | 現在不勾 |
| 2.2 390px 控制與長字串 overflow | 部分滿足 | CSS 有 `overflow-wrap:anywhere`；E2E 有 390x844 document/viewport overflow assertion | 未在 390px 依序操作 small/medium/large；fixture 是短文字，不是 long/unbroken bilingual text | 現在不勾 |
| 2.3 現有 Viewer 內容與 history anchor 保留 | 部分滿足 | 已測 history mode/follow-latest、QR、visibility、fullscreen、Cue 與 scroll preservation 的部分組合 | 未在同一尺寸變更 flow 明確斷言 title、meeting name、share link、兩個 toggles、fullscreen、existing Cues 與 anchor 全部仍在 | 現在不勾 |
| 3.1 比對 Viewer 功能文件 | 已滿足（內容） | `docs/features/meeting-center-live-viewer.md` 已描述三段字級、localStorage、fullscreen/Pause-Continue、Cue/connection/history/anchor 不重置；commit `6bde950` 同步修改 | 仍需在後續 apply/review 記錄此對照結果 | 可在使用者核准後單獨勾選，本次不勾 |
| 3.2 驗證與記錄 | 部分滿足 | `openspec validate ... --strict` 本次通過 | 本次未執行 focused unit/Playwright；未有完整結果記錄；real-device touch/native fullscreen 仍未驗 | 現在不勾 |

總結：內容上 **1 項已滿足、6 項部分滿足、0 項完全無實作證據**。由於 tasks 是 workflow 驗收記錄，本次不勾任何項目。

### 七項 task 的剩餘驗收與變更類型

「需補測試」指後續獨立實作階段，並不授權本階段修改測試。除非補測重現產品行為缺陷，現有證據不支持直接改產品碼。

| Task | 尚未滿足的驗收條件 | 需補測試 | 需改規格／記錄 | 需改產品碼 |
|---|---|---|---|---|
| 1.1 | 完成 source-to-artifact 最終比對與差異記錄，確認不觸及 transport/replay。 | 否 | 是：已將「已存在實作」與未驗邊界寫入 design；仍待核准後 review。 | 無已證明必要性 |
| 1.2 | `medium` 寫入／讀回、storage 不可用及 `getItem`／`setItem` throw 的 fail-open case 尚無明確斷言。 | 是：偏好 helper unit | 否 | 只有補測失敗才評估 |
| 2.1 | `small` 雙語、隱藏後再顯示的繼承、native fullscreen 中選定字級、reconnect 後保留字級未完整驗收。 | 是：focused Viewer E2E | 否 | 只有補測失敗才評估 |
| 2.2 | 390px 下所有字級控制、長且不斷行的 source／translation、controls 的 aria state 與 overflow 未完整驗收。 | 是：focused responsive E2E | 是：spec 已把 default 寫成可量測的 medium 雙語 scenario | 只有補測失敗才評估 |
| 2.3 | 同一 resize flow 尚未同時斷言 meeting title/name、QR/share link、visibility/history toggles、fullscreen、既有 Cues 與閱讀錨點不被重置。 | 是：focused regression E2E | 否 | 只有補測失敗才評估 |
| 3.1 | 功能文件內容已對齊，但 apply/review 紀錄尚未完成。 | 否 | 是：記錄已核對的文件與 SHA | 否 |
| 3.2 | 需記錄 strict validation、focused unit/E2E 命令與結果、browser project、commit SHA；真機若不可用明列 `NOT_VERIFIED`。 | 是：執行既有／補足的 focused tests | 是：tasks 已補驗證記錄條件 | 否 |

Phase 3A 已調整 proposal、design、delta spec 與 tasks 的措辭；七個 checkbox 全部保持未勾，沒有 archive。`3.1` 僅「內容已滿足」，不是 workflow 完成。任何後續產品碼修正必須由實際失敗測試或重現證據觸發。

### Proposal／Design／Spec 一致性

| Artifact | 審查結果 | 需調整處 |
|---|---|---|
| `proposal.md` | 大致一致，且正確承認第一版實作已存在 | 將「Add focused coverage」改寫為「close the enumerated coverage gaps」，避免讓人誤以為目前沒有任何測試 |
| `design.md` | 實作擁有權、stable shell、CSS variable、localStorage fail-open、anchor 處理與程式一致 | 將「Confirmed current behavior」的 browser coverage 拆成「已有自動測試」和「尚未驗假設」；明列 hidden inheritance、storage throw、small/native fullscreen/reconnect 組合未驗 |
| `viewer-subtitle-display/spec.md` | 要求本身與產品方向一致，未觸及 transport/API/security | 在通過 apply 前，mobile operability、long-unbroken overflow、native fullscreen 與 reconnect scenario 只是 target contract，不得標成 current verified baseline；touch comfort 保持為 real-device 驗收限制 |
| `tasks.md` | 任務範圍正確，無需擴大到 transport 或後端 | 1.2/2.1/2.2/2.3 已準確指向現有測試缺口；3.2 應要求記錄 command、project/browser、commit SHA 與未驗環境 |

### Reviewer 調和建議

1. 保留此 change 為「既有實作的契約化 + 小範圍測試補齊」，不重寫 Viewer 或觸及 transport。
2. 先更正 artifacts 中對「已覆蓋」與「尚待驗」的描述，再由獨立 apply turn 補最小測試缺口。
3. 自動驗證應限定為 `viewerFontSizePreference.test.js` 與 `meetingViewerFullscreen.spec.js` 相關 title filter；不跑全套 E2E。
4. iOS Safari/native fullscreen/touch comfort 若環境不可用，在驗證記錄保留 `NOT VERIFIED`，不阻塞 program-level capability，也不得宣稱真機通過。
5. 未取得使用者核准前，不勾 tasks、不 sync、不 archive。

## 第三部分：11 模組正式 specs 移轉順序

| 順序 | 模組 | 現行需求契約 | 尚未確定的行為 | 已知缺陷 | Issue | 可驗證 Scenario | 移轉前阻礙 |
|---|---|---|---|---|---|---|---|---|
| 1 | Meeting Lifecycle | Meeting 最多一 open Session/一 active Segment；transactional commands；operation id/lifecycle version；lease/fence；rollover/recover/takeover/stop；v2 Cue boundary；manual retention/deletion | Preview/Production 的並發時序、lease expiry/takeover 實際行為；部署 migration head | 無已確認的 current program defect；部署狀態不明 | #1, #3, #4, #37；PR #39 | duplicate command 回原結果；stale fence 409；rollover 只建一 successor；stop 後拒絕新寫入 | 確認 baseline commit；拆清 lifecycle v1 compatibility 與 v2 current contract；解決舊 cleanup 文字 |
| 2 | PCM Queue / Audio Buffering | AudioWorklet 優先、ScriptProcessor fallback；PCM16 mono；provider-not-ready 有界 queue；64 chunks/480,000 bytes 預設上限；overflow 丟最舊且可觀測；epoch 擋舊 callback | 真機 callback jitter、Safari fallback、長時間壓力下的 drop rate；上限是否屬公開契約 | 無已確認的 Production defect；queue drop 是已設計降級且可造成 Live gap | #5, #38, #41 | provider 未 ready 後 drain；overflow 只保留最新 window；transition 不重送舊 PCM；cleanup 釋放 graph | 決定 queue 數值是 normative 還是 implementation detail；保留真機 `NOT VERIFIED` |
| 3 | Viewer Subtitle Sync | share auth；snapshot/pagination；WebRTC DataChannel 優先；cursor replay；Cue version ordering/dedupe；fallback/recovery 保留 Cue、visibility、scroll/fullscreen | Production incident root cause；10/50/100 peers；direct/TURN/fallback 選型；cross-process delivery | Production 事故僅 `UNKNOWN`，不得寫 root cause | #31, #38, #41；PR #40 | late snapshot 不覆寫新 Cue；replay gap 回補；duplicate revision 丟棄；recovery exhausted 保留畫面 | 需成對 Recorder/Viewer trace；規格不預設 TURN/relay；與 Viewer Display capability 分離 |
| 4 | OPFS / IndexedDB | audio bytes 在 OPFS；Cue/checkpoint/operation/audio metadata 在 IDB；reserve-write-seal；immutable identity/hash/version；reload reconcile/quarantine；credential projection | quota exhaustion、private mode、Safari support、離線重送、長時間 cross-tab lock | 無已確認的 Production defect；真機恢復不明 | #37, #38, #41；PR #39 | reload 後不覆寫 sealed chunk；duplicate identity conflict；secret-shaped fields 不落地；OPFS failure 可重試 | 需 Preview 真實瀏覽器 reload/crash/quota/offline 證據；明確 unsupported-browser 契約 |
| 5 | Session Rollover / Reconnection | retry classification；fresh token；provider epoch 替換不重建 capture owner；operation reconciliation；3-attempt provider recovery；pause/resume/rollover Segment boundary | real Gemini GoAway/token expiry；proactive rollover；音訊無縫性；LAR-16～21 | 60-second WebM rotation candidate 在隔離 Chromium 實驗失敗，不是已確認 provider reconnect defect | #3, #4, #38, #41 | timeout 後 reconcile committed result；403 不重試；stale epoch callback 無效；stop 取消 reconnect | 先更正 defect scope；不將 #41 未完任務寫成 current requirement |
| 6 | Gemini Live Transcription / Translation | browser 用 ephemeral token 直連 Live Translate；setupComplete 後開始；input/output partial/final 合併 Cue；translated audio preference；credential 不落地 | model/SDK 真實行為；provider transcript ordering；token/session 實際壽命 | 無本次確認的 Production defect | #2, #20, #41；PR #24 | partial 更新同 Cue；source-only/translation-first；stop flush；credential redaction；playback disabled 不播放 | 真實 Gemini 需另行授權；Transcribe Live + Flash pipeline 必須保留 `PLANNED` |
| 7 | Supabase / Cloud Sync | cloud 保存帳號/權限/settings/dictionaries/entry metadata；local recorder 仍是 lifecycle owner；ACK 對應 durable commit；idempotency/version/hash；channel failure 不報 synced | 當前部署 migration/RLS/storage policies；staging/production config | 無已確認的 repository defect；部署一致性 `UNKNOWN` | #35, #37；PR #39 | duplicate upload/cue/checkpoint 回原結果；stale fence 拒絕；channel retry 保留 operation id | 需 verification manifest 綁定 commit/deployment/migration head/RLS/browser |
| 8 | Glossary | global/meeting CRUD；CSV/JSON/XLSX preview/apply；deterministic revision；Meeting override；Segment provider snapshot；Turn-level local correction | 真實 provider instruction 品質；大量詞彙上限；並發編輯 | 無已確認的 current program defect | #37；PR #30, #36 | revision 對排序穩定；longest-first replacement；Save/Continue revision boundary；invalid import 拒絕 | 把 provider quality 與 deterministic application contract 分開；保留 scale `UNKNOWN` |
| 9 | Recording / Export | MediaRecorder start/pause/resume/finalize；writer drain 先於 finalize；local audio export；Cue TXT/SRT/VTT；cloud artifact queued/processing/ready/stale；signed URL | 分割 container 策略；Gap Recovery；真機長錄音連續性 | non-initial WebM slice 解碼與60-second rotation candidate 僅在隔離 Chromium 實驗已確認失敗；Production impact `UNKNOWN` | #6, #16, #38, #41；PR #17 | finalize 等寫入；multiple complete containers -> WAV；source hash 變更使 artifact stale；format/stream validation | 規格先排除 Gap Recovery/rotation；待 Phase B 決策後另開 change |
| 10 | Authentication / Administration | Supabase session/profile gate；domain allowlist；trusted pending activation；member/super_admin；role/status/asset transfer；audit redaction | Preview/Production OAuth redirect/env；RLS deployment；emergency admin recovery | 無已確認的 current program defect | #33；PR #34 | pending -> active 僅 trusted backend；self-disable 拒絕；role RPC atomic；unauthorized UI 不進 app | 需部署驗證；不把 mock E2E 當 OAuth Production 證據 |
| 11 | UI / RWD / Fullscreen | responsive breakpoints；Viewer CSS/native fullscreen；visibility/auto-follow；small/medium/large 雙語字級；local preference | iOS Safari/toolbars/safe-area；physical touch comfort；極端長字串與多引擎 | 無已確認的 Production defect；OpenSpec 測試覆蓋不完整 | #29；`formalize-viewer-subtitle-font-size` | 尺寸雙語同步；reload/fullscreen 保留；390px 無水平 overflow；anchor 不重置 | 先完成現有 change 的最小覆蓋缺口；真機保留未驗 |

### 移轉批次建議

```text
Batch A: Meeting Lifecycle -> PCM Queue / Audio Buffering
Batch B: Viewer Subtitle Sync -> OPFS / IndexedDB
Batch C: Session Rollover / Reconnection -> Gemini Live
Batch D: Supabase / Cloud Sync -> Glossary
Batch E: Recording / Export -> Authentication / Administration
Batch F: UI / RWD / Fullscreen
```

每批最多兩個 capability。Viewer Subtitle Sync 與 UI/Display 分開，避免將 transport recovery 與純 presentation preference 寫在同一 spec。

### Phase 3A 現行規格資格閘門（只提出候選，不建立主規格）

以下四項均**有條件具備**建立「現行程式契約」的證據：源碼與自動測試可追溯，但 Preview／Production 驗收未完成。Scenario 是後續審核用候選，並非已採納的正式 OpenSpec Requirement；不可將未列明的 SLA、跨瀏覽器保證或未採納設計補入主規格。

| 模組／資格 | 候選 Requirement 與可驗證 Scenario（WHEN → THEN） | 程式／測試／SHA 證據 | 移轉前阻礙 |
|---|---|---|---|
| Meeting Lifecycle：有條件通過 | ML-1：同一 Meeting 開啟首個 Session／Segment → 僅有一個 open Session 與 active Segment。ML-2：同一 operation id 重送 lifecycle command → 回傳原結果而不重複建立邊界。ML-3：舊 lifecycle version／fence 寫入 → 拒絕 stale command，且不改動 active Segment。ML-4：stop 成功後再次送交寫入 → 不新增 Cue／Segment。 | `src/application/meetingCheckpointService.js`、`src/infrastructure/supabaseMeetingLifecycleService.js`、`tests/unit/meetingLifecycleHttpApi.test.js`、`tests/unit/meetingCheckpointService.test.js`、lifecycle migration；`2bdd676`、`9d05c08`；repository/unit/integration，部署未驗。Issue #1/#3/#4/#37，PR #39。 | 釐清 v1 相容邊界、當前部署 migration head、真實並發 lease/takeover；不可宣稱 Production 已驗。 |
| PCM Queue / Audio Buffering：有條件通過 | PCM-1：capture callback 產生音訊且 provider ready → 提交 PCM16 mono chunk。PCM-2：provider 未 ready 且 pending queue 達 64 chunks 或 480,000 bytes → queue 保持有界，超額採既有丟棄策略並記錄 drop。PCM-3：provider transition 後恢復 ready → 只 drain 仍有效的 pending chunk，不向舊 provider replay。PCM-4：AudioWorklet 不可用 → 依現有 fallback 啟動 ScriptProcessor capture。 | `src/lib/audio.js`、`src/lib/audioCapture.worklet.js`、`src/lib/liveSession.js`、`tests/unit/audio.test.js`、`liveSessionProviderTransition.test.js`；`9cc3d9f`；unit/mock，真實裝置與長時段未驗。Issue #5/#38/#41。 | 核對 PCM sample-rate 實際轉換與 callback/frame 單位；真實裝置及長時段壓力、provider gap 未驗。 |
| OPFS / IndexedDB：有條件通過 | LOC-1：錄音 chunk reserve→write→seal 完成 → IDB metadata 與 OPFS bytes 可用 immutable identity 關聯。LOC-2：同 identity 不同 hash/version 再寫入 → 回報衝突，不覆寫 sealed chunk。LOC-3：reload 時發現 pending/inconsistent record → reconciliation 將其恢復或隔離，不冒充已封存。LOC-4：持久化含 credential-shaped input → storage projection 不保存 token／secret。 | `src/lib/localMeetingStorage.js`、`localMeetingRecorder.js`、`localMeetingPersistence.js`、storage/recorder/reload/retention tests；`9cc3d9f`、`e3194f0`、`57974bc`；unit/模擬瀏覽器，Safari/private/quota/Production 未驗。Issue #37/#38/#41，PR #39。 | OPFS unsupported-browser、quota/offline/crash 的應對不可臆測；需實瀏覽器與部署記錄。 |
| Glossary：有條件通過 | GLO-1：同一詞彙集合以不同輸入順序建 revision → 產生相同 deterministic revision。GLO-2：meeting override 與 global 項目同時命中 → 依現行 precedence 選 meeting 項目。GLO-3：Segment 啟動後 glossary 有更新 → 該 Segment 保持啟動時 provider snapshot，後續邊界使用新 revision。GLO-4：Turn local correction 套用 → 僅調整本地顯示結果，不反寫 provider 歷史。GLO-5：匯入含不合法列 → preview/apply 依現行驗證回報或拒絕，不默默當成已套用。 | `src/features/glossary/index.js`、`src/lib/meetingGlossary.js`、`src/lib/glossaryRevision.js`、`src/infrastructure/supabaseGlossary.js`、`tests/unit/glossaryRevision.test.js`、`tests/unit/glossaryContinueContract.test.js`、`tests/unit/glossaryHttpApi.test.js`；`a915642`、`51f60c5`；unit/integration/mock E2E，真實 Gemini 品質未驗。Issue #37，PR #30/#36。 | provider instruction 品質與詞彙量上限未知；須先鎖定 precedence 與 revision 的測試條件，不寫成 provider SLA。 |

候選 Scenario 仍須在 Phase 3B 逐條核對具體函式／測試斷言後，經使用者審核才可轉為正式 `openspec/specs/`。本階段沒有建立主規格。

## 第四部分：Git 版本控制檢查

### 目前工作樹

**盤點前已存在的 tracked 產品／測試變更，不可混入：**

- `CHANGELOG.md`：2 additions。
- `docs/features/audio-device-selection.md`：5 additions。
- `tests/e2e/liveTranslate.spec.js`：50 additions、1 deletion。

**目前 untracked：**

- `.agents/skills/*`：OpenSpec tooling/skill files，不屬盤點文件。
- `openspec/config.yaml`、`openspec/specs/.gitkeep`、change artifacts、archive placeholder。
- `docs/spec-audit/` 六份盤點文件（含本文）。

### 安全的獨立提交方案

**Commit A：只收盤點報告**

```bash
git add -- \
  docs/spec-audit/system-inventory.md \
  docs/spec-audit/feature-matrix.md \
  docs/spec-audit/known-gaps.md \
  docs/spec-audit/roadmap-candidates.md \
  docs/spec-audit/openspec-migration-plan.md \
  docs/spec-audit/baseline-review.md
git diff --cached --name-only
git diff --cached --check
git commit -m "docs: add OpenSpec baseline audit"
```

預期 staged name list 必須只有上述 6 檔。不使用 `git add .`、`git add -A` 或 `git commit -a`。

**Commit B：納入 OpenSpec bootstrap/change，僅在另行核准後**

```bash
git add -- \
  openspec/config.yaml \
  openspec/specs/.gitkeep \
  openspec/changes/archive/.gitkeep \
  openspec/changes/formalize-viewer-subtitle-font-size/.openspec.yaml \
  openspec/changes/formalize-viewer-subtitle-font-size/proposal.md \
  openspec/changes/formalize-viewer-subtitle-font-size/design.md \
  openspec/changes/formalize-viewer-subtitle-font-size/tasks.md \
  openspec/changes/formalize-viewer-subtitle-font-size/specs/viewer-subtitle-display/spec.md
git diff --cached --name-only
git diff --cached --check
git commit -m "chore: initialize OpenSpec workflow"
```

Commit B 之前應先套用本文的 artifact 調和建議；不含 `.agents/`、不含三個原有 tracked 修改。

### 提交前必要檢查

1. `git status --short` 確認產品修改仍未 staged。
2. `git diff --cached --name-only` 與允許清單逐一一致。
3. `git diff --cached --check` 無 whitespace error。
4. Commit A/B 分開；`.agents/` 是否納入版控另做專案層決策。
5. 不重置、不 stash、不 restore 盤點前的使用者變更。

## Phase 3A 完成報告與驗證

- 分類修正：Rollover 的 #41 15 分鐘線索為 `SUSPECTED`；實際 provider／Preview／Production `NOT_VERIFIED`。Recording/Export 現行路徑仍有程式與測試證據；隔離 Chromium 149.0.7827.55/macOS 的非初始 WebM slice `EncodingError` 與 60 秒 rotation −25.33 ms 失敗完整保留為 `REPRODUCED_IN_TEST`，不外推為 Production 缺陷。`CONFIRMED_PRODUCTION`／`CONFIRMED_PREVIEW` 均無足夠證據。
- Viewer change：七項 task 逐項分類；1 項內容滿足、6 項部分滿足；checkbox 仍 0/7。proposal、design、delta spec、tasks 只調和現況與驗收語句，不改產品碼。
- 規格資格：Meeting Lifecycle、PCM Queue、OPFS/IndexedDB、Glossary 可作**有條件**的現行契約候選；上表各 Requirement 均附可驗證 WHEN/THEN Scenario，但仍須核准及逐條核對斷言後才建立正式主規格。
- 驗證：`openspec validate formalize-viewer-subtitle-font-size --strict` 通過；十份審查／change Markdown 的具體本機路徑存在（排除明示 glob／placeholder）；盤點與 change 文件無行尾空白、均有結尾換行。未執行 unit、E2E、真實 Gemini 或 Preview/Production 驗證。
- Git 範圍：`git status --short` 顯示原有三個 tracked 修改仍是 `CHANGELOG.md`、`docs/features/audio-device-selection.md`、`tests/e2e/liveTranslate.spec.js`；`git diff --name-only` 亦僅此三檔；`git diff --cached --name-only` 為空。`.gitignore` 無 `docs/spec-audit/` 或 `openspec/` 排除規則；兩組精確 add 清單見上，**本次未執行**。

## 停止點

Phase 3A 僅修正 `docs/spec-audit/` 盤點與既有 Viewer OpenSpec change 草案；未建立正式主 specs，未勾選七項 tasks，未 sync/archive change，未 staged/commit/push/merge Git，未修改產品程式、API、資料庫、測試或部署設定。
