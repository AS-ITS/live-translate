# Live Translate OpenSpec 移轉計畫

## 目標與護欄

- 目標：將「已實作且可證明」的 capability 轉成耐久 OpenSpec 規格。
- 本階段只完成盤點，不建立正式 `openspec/specs/*/spec.md`，不套用 change。
- `PLANNED`、`UNKNOWN`、`KNOWN_DEFECT` 的期望行為不得包裝成當前 requirement。
- 每一個 spec 需有程式證據、測試證據、環境驗證欄位與已知限制。

## 階段 0：審核本盤點

1. 審核 `system-inventory.md`、`feature-matrix.md`、`known-gaps.md`、`roadmap-candidates.md`。
2. 確認狀態定義與 P0/P1/P2 排序是否符合產品決策。
3. 選定可重現 baseline commit，決定盤點前的 dirty changes 是否納入。
4. 確認 `openspec/` 是否納入 Git，以及現有 viewer-font-size change 的擁有者與用途。

出口條件：使用者明確核准盤點；在此之前不建立正式 specs。

## 階段 1：處理現有 OpenSpec change

### `formalize-viewer-subtitle-font-size`

1. 逐條對照 delta spec 與目前程式，記錄「已存在」、「測試覆蓋」、「真機未驗」，不以 commit 名稱取代驗證。
2. 只在驗證後勾選對應 tasks；尚未驗的 iOS Safari/native fullscreen 保留未驗標記。
3. 決定該 change 是「補寫既有行為」或「仍有产品差異待實作」。
4. 未完成檢查前不 archive，不將 delta spec 當作已生效主規格。

## 階段 2：以 capability 小批移轉

建議每批最多 2 個 capability，每個 capability 可支撐 2～3 個相關實作功能，避免一個 UI action 就建一份 spec。

| 批次 | capability 候選 | 可先寫的 current requirements | 必須排除／另開 change |
|---|---|---|---|
| A | Meeting Lifecycle v2 | state invariants、transactional commands、lease/fence、idempotency、Segment boundaries、manual retention/deletion | 未驗證部署 SLA，舊 automatic cleanup 敘述 |
| A | Local Durability & Delivery | OPFS/IDB ownership、immutable chunk、queue dependency/hash/version、ACK/retry/reload reconciliation | Gap Recovery、quota/offline SLA、零音訊損失保證 |
| B | Viewer Subtitle Delivery | share auth、snapshot/replay、DataChannel ordering/dedupe、fallback state | TURN/relay 選型，Production 根因未明的修復敘述 |
| B | Viewer Subtitle Display | source/translation visibility、auto-follow、responsive/fullscreen、size preference | 未真機驗收的 touch/native fullscreen 保證 |
| C | Glossary | scopes、CRUD/import、revision、Segment snapshot、Cue correction invariants | 未驗的 provider 品質／大量詞彙 SLA |
| C | Auth & Administration | trusted activation、roles/status、RLS boundaries、audit safety | 未驗的部署 env/OAuth/RLS 保證 |
| D | Recording & Export | recorder state、finalization ordering、Cue TXT/SRT/VTT、cloud artifact lifecycle | WebM rotation/Gap Recovery，直到 GAP-001/002 結案 |

## 階段 3：規格撰寫規則

1. 每條 requirement 必須對應至少一個目前程式位置；無程式證據者改列 `PLANNED`。
2. 每個 scenario 標示驗證層級：unit、integration、mocked browser、Preview、Production、real device、real Gemini。
3. 歷史 Issue/PR 放 traceability，不放在「實作證據」的唯一來源。
4. 若文件與程式衝突，spec 先保留衝突與未解決決策，不自行挑一邊。
5. 已知缺陷不寫成 SHALL 正常行為；要修正時以獨立 change 提案。

## 階段 4：驗證與同步舊文件

1. 先用 mock/unit/integration 驗證 requirement，只在必要且獲授權時用真實 Gemini。
2. 依 RC-002 建立 Preview/Production verification manifest。
3. 主 specs 通過審核後，再更新 `docs/spec.md`、architecture 與 feature docs 的過時說法；不建立重複文件。
4. 每批 change 只在 artifacts、實作對照、targeted tests 與必要環境證據完整後 archive。

## 正式 OpenSpec 建立前檢查表

- [ ] 使用者已審核本次盤點。
- [ ] baseline commit 與 dirty working tree 範圍已確認。
- [ ] `openspec/` 版本控制決策已確認。
- [ ] viewer-font-size 現有 change 已逐條對照。
- [ ] 首批 capability 的 current/planned/defect 邊界已確認。

## 停止點

本計畫停在盤點文件。必須等待使用者審核與指定首批 capability，才能建立或更新正式 OpenSpec 規格。
