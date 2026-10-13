# Live Translate OpenSpec 路線圖候選

> 這些是審核候選，不是現行 OpenSpec 規格，也不表示已承諾實作。

## P0：先建立可信基線

### RC-001 固定版本基線與 OpenSpec 納管範圍

- 解決：`openspec/` 未追蹤、dirty working tree 令盤點無法一致重現。
- 建議產出：審核後選定 baseline commit，確認現有 viewer-font-size change 是補規格還是待實作 change。
- 不含：不自動勾選 tasks，不建立批量 specs。

### RC-002 Preview／Production 驗證證據包

- 範圍：Origin/CORS、auth redirect/domain、Supabase migration head/RLS、Meeting lifecycle、Viewer signaling/WebRTC/fallback。
- 建議產出：每次驗證記錄 commit SHA、deployment ID/URL、DB migration head、browser/device、測試指令與結果。
- 晉級規則：程式+測試檔只能是 `CONFIRMED_IMPLEMENTED`（program）；目標環境通過後才能標示 Preview/Production verified。

### RC-003 長錄音與 Gap Recovery 決策

- 追溯：[#41](https://github.com/pochun1021/live-translate/issues/41)。
- 前置：先處理 WebM slice decode 與 60 秒 rotation gate，再選 Phase B 容器／封裝方案。
- 不可提前寫入 current spec：中斷音訊自動補轉錄、LAR-16～21、零缺口或永不失敗保證。

### RC-004 Production Viewer 事故診斷與大規模矩陣

- 前置：收集同 incident/build 的 Recorder + Viewer trace。
- 矩陣：10/50/100 viewers，不同網路，direct/TURN/fallback，snapshot/replay 下的 ordering、latency、recovery。
- 決策點：實驗後才能選 TURN 或有限 relay，不預設新基礎設施。

## P1：收斂已實作能力

### RC-005 Meeting Lifecycle v2 正式 capability spec

- 收錄：Meeting/Session/Segment invariants、transactional commands、lease/fence、idempotency、rollover/recover/takeover/stop、manual deletion/retention。
- 分開標記：legacy compatibility 與 v2 current behavior。
- 前置：RC-001，並解決自動 cleanup 與手動 deletion 敘述衝突。

### RC-006 Local Durability 與 Cloud Delivery capability spec

- 收錄：OPFS bytes、IDB cue/checkpoint/operation/audio queues、immutable sequence/hash/version、ACK/idempotency、reload reconciliation、retention locks。
- 不收錄：尚未驗證的 quota/offline SLA 數字與 Gap Recovery。
- 前置：RC-002 至少完成一組 Preview 真實瀏覽器證據。

### RC-007 Viewer Subtitle Delivery 與 Display capability specs

- 建議邊界：
  - Delivery：share auth、snapshot/pagination、cursor replay、WebRTC protocol、ordering/dedupe/recovery。
  - Display：visibility、auto-follow、fullscreen、responsive layout、subtitle size preference。
- 前置：對現有 `formalize-viewer-subtitle-font-size` 逐條驗證，不以 tasks 未勾選推論程式未實作。

### RC-008 Glossary capability spec

- 收錄：global/meeting scope、import preview/apply、revision canonicalization、Segment snapshot、Turn-level correction refresh、已 finalized Cue 不回改原則。
- 延後：大詞彙上限、翻譯品質與真實 Gemini instruction 規格，待驗證後補。

### RC-009 Auth / Administration / Audit capability spec

- 收錄：trusted pending activation、domain allowlist、member/super_admin 邊界、role/status 變更、asset transfer、audit safety。
- 前置：Preview/Production OAuth redirect、env 與 RLS 驗證。

### RC-010 Recording / Export capability spec

- 可先收錄：Cue-backed TXT/SRT/VTT semantics、cloud artifact lifecycle、signed download、source-hash stale detection。
- 暂緩：分割 WebM/Gap Recovery 部分等 GAP-001/002 決策。

## P2：尚未實作或需產品決策

- `gemini-3.5-transcribe-live` + Flash translation/refinement 成為正式 recorder pipeline。
- 音訊輸出裝置選擇。
- 大規模 Viewer 所需的 TURN／有限 relay 供應商與成本模型。
- 未在當前程式建立證據的 multi-user room、payment 或外部 dashboard。
