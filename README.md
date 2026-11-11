# Live Translate

Live Translate 是以瀏覽器為主的即時語音翻譯工具。Host 在自己的瀏覽器錄音，透過後端核發的短效 token 直接連接 Gemini Live API；Viewer 可透過分享連結觀看即時字幕。專案使用 React、Vite、Node.js、Supabase，以及 WebRTC DataChannel。

## 專案介紹與開發背景

本專案從單人即時翻譯 Demo 發展為會議導向的內部工具。目前正式錄製路徑採 **Local-only** 架構：錄音與字幕內容由 Host 的瀏覽器保存，雲端只承擔會議設定、授權及連線協調。開發里程碑與歷史變更見 [ROADMAP](docs/ROADMAP.md) 及 [CHANGELOG](CHANGELOG.md)。

目前不是開放註冊的公開服務。本機啟動流程固定使用 `as.edu.tw` 登入網域，Google Workspace 帳號仍須符合目前的授權規則；取得 Viewer 連結也不等於取得 Host 的本機錄音檔。

## 核心功能

- 建立會議、調整來源與目標語言、會議字典及錄製設定，再產生 Viewer 分享連結／QR code。
- Host 使用麥克風進行即時翻譯，顯示原文與譯文字幕，並可控制錄製、暫停、繼續與結束。
- Viewer 經授權後透過 WebRTC DataChannel 接收 Host 傳送的即時字幕、快照與重播事件。
- Host 可在**同一瀏覽器的本機資料仍可用時**，查看會議內容，並下載本機錄音及 TXT／SRT／VTT 字幕；結束後的本機內容受既有 30 分鐘保留期限約束。

## 系統架構與資料流

```text
Host 麥克風 → Host 瀏覽器 → Gemini Live API（即時音訊／翻譯）
                         ↘ OPFS／IndexedDB（本機錄音與字幕資料）
Host 瀏覽器 → Node.js API → Supabase（會議設定、授權與協調資料）
Host 字幕 → WebRTC DataChannel → Viewer 瀏覽器
                 ↖ Redis／Node.js API 協調 WebRTC signaling
```

Node.js API 驗證登入與會議權限，核發 Gemini 短效 token；即時麥克風音訊由 Host 瀏覽器直接送往 Gemini，不經後端音訊代理。Viewer 以 API 取得授權與會議 metadata，透過 signaling 建立 WebRTC 連線；字幕由 Host 的 DataChannel 傳送。

## 雲端與本機資料儲存邊界

| 位置 | 保存或傳遞的資料 |
| --- | --- |
| Supabase | 會議 metadata／設定、字典，以及必要的帳號、授權與分享協調資訊；不持久化正式錄製內容。 |
| Host OPFS／IndexedDB | PCM、錄音區塊、Cue、Transcript、Checkpoint、Journal 與 Recovery 資料；由 Host 本機持久化與恢復。 |
| Viewer WebRTC DataChannel | 接收 Host 當下提供的即時字幕、快照與重播；不提供雲端錄音資料恢復。 |

Host 重新載入後的恢復依賴**同一瀏覽器、同一來源的本機儲存**。清除瀏覽器資料或換到另一部裝置後，不能依賴 Supabase 還原錄音、Cue 或 Transcript。Viewer 也不能從雲端恢復或下載其他 Host 的會議內容。會議結束後的存取期限及 Host 本機清理依現行保留規則處理，詳見[架構總覽](docs/architecture/architecture-overview.md)。

## 系統需求

- **Node.js 與 npm：**CI 使用 Node.js 22；長會議測試另涵蓋 Node.js 24。`package.json` 未宣告最低 Node 版本，首次安裝建議先使用 CI 的 Node.js 22。
- **本機服務：**Docker、Supabase CLI、`redis-cli` 與 `redis-server`。`npm run start` 會檢查本專案 Supabase migration 是否已套用，並檢查或啟動 loopback Redis。
- **登入設定：**可用的本機 Google OAuth client；client ID 設於 `supabase/config.toml`，client secret 須由使用者自行取得並設於 `supabase/.env.local`。本機啟動器要求該檔為一般檔案且權限為 `600`。
- **瀏覽器：**須支援麥克風存取、Web Audio、OPFS／IndexedDB 與 WebRTC DataChannel。現有文件尚未宣告完整的正式支援版本矩陣；RC1 的 Chrome／Safari 實機矩陣仍待驗收。

## 本機安裝與環境設定

在專案根目錄安裝鎖定版本的依賴：

```bash
npm ci
```

本機 Google OAuth secret 放在 Git 忽略的 `supabase/.env.local`，鍵名為 `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET`；將檔案權限設為 `600`。請勿將 secret、Gemini API key 或短效 token 提交至版本控制或寫進前端變數。

`npm run start` 的本機啟動器直接從 loopback Supabase 取得 URL 與金鑰，並為 API、Vite 設定所需的 `SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`SUPABASE_JWKS_URL`、`VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`、`AUTH_ALLOWED_EMAIL_DOMAINS`、`WEBRTC_SIGNALING_REDIS_URL` 與 `APP_ORIGIN`。**此啟動流程不讀取專案根目錄的 `.env` 作為必填設定。**[`.env.example`](.env.example) 是其他手動或部署環境的變數參考，不應直接當成本機啟動清單。

真實 Gemini Live 翻譯使用錄製者在介面提供、僅供該次請求使用的 API key 取得短效 token；本機啟動器會將伺服器端 `GEMINI_API_KEY` 設為空值。`GEMINI_API_KEY` 只供另行設定的非 Live 後端工作使用，絕不可使用 `VITE_` 前綴公開。若沒有可用的 Google OAuth 設定或符合授權規則的帳號，目前無法完成一般使用者的本機登入流程。

## 啟動方式

從本專案根目錄執行：

```bash
npm run start -- --check
npm run start
```

第一個指令會檢查本機 Supabase、migration、Google OAuth、Redis 與環境，必要時可能啟動本機服務；它不是純唯讀檢查。第二個指令啟動 Node.js API（預設 `127.0.0.1:3000`）與 Vite（預設 `127.0.0.1:5173`）。請以終端實際印出的 Vite URL 為準。`npm run start:local` 是同一啟動腳本的別名。若 migration 不一致，啟動器會阻止啟動；資料庫初始化或修復請先參考[開發文件](docs/development.md)，勿對既有資料庫盲目執行 reset。

## 基本使用流程

1. 使用符合目前授權規則的 Google Workspace 帳號登入。
2. 在會議管理介面建立會議，設定語言、字典與錄製選項，取得 Viewer 連結或 QR code。
3. Host 開始錄製並允許麥克風權限；即時翻譯與字幕開始後，可暫停、繼續或結束。
4. Viewer 開啟分享連結，經授權後觀看 Host 透過 DataChannel 傳送的即時字幕。
5. Host 結束後，在同一瀏覽器、保留期限內查看或匯出本機錄音與字幕。

## 已知限制與 RC1 驗收狀態

截至 **2026-11-09**，`RC1_RELEASE_VERDICT=BLOCKED`。測試文件已記錄 **130 分鐘錄製功能測試 PASS**（含 8/8 rollover、9 個 Segment、PCM／Journal／Cue／Checkpoint 與 End／Reload 回讀），以及 **Cloud Zero Write PASS、11/11 Evidence Checks PASS**。但 **RAM Gate FAIL**：最後 30 分鐘 RSS slope 為 **1.999 MiB/min**，高於暫定的 0.5 MiB/min 門檻；現有證據尚不能判定是否為產品自身的記憶體洩漏。該次長測的原始報告在目前工作目錄不可取得，因此尚無法獨立重驗。一般使用者的 Host／跨裝置 Viewer、斷線重連及 Chrome／Safari 裝置矩陣等 **RC1 實機手動驗收仍未完成**；上述功能測試 PASS 不代表 RAM Gate 或 RC1 實機驗收通過。

目前本機啟動與登入仍依賴已配置的 Google OAuth、Supabase migration 和 Redis。跨裝置 Viewer 的網路與 WebRTC 行為須以實機驗證；瀏覽器本機資料遺失後無雲端錄製內容可還原。最新驗收細節與未完成項目見[測試文件的 RC1 狀態](docs/TESTING.md#issue-41-rc1-acceptance-status-2026-11-09)。

## 開發與測試文件連結

- [產品規格](docs/spec.md)與[架構總覽](docs/architecture/architecture-overview.md)：產品背景、現行 Local-only 邊界及歷史設計脈絡。
- [架構細節](docs/architecture.md)與 [API 文件](docs/api.md)：元件責任與 API 契約；部分段落仍記錄舊路徑，請以現行 Local-only 章節及正式產品呼叫路徑為準。
- [安裝與開發指南](docs/development.md#正式本機安裝與啟動現行-local-only-路徑)與[貢獻指南](CONTRIBUTING.md)：系統需求、本機初始化與協作流程。
- [使用指南](docs/USER_GUIDE.md)與[部署指南](docs/DEPLOYMENT.md)：Host／Viewer 操作、環境隔離與部署邊界。
- [測試與 RC1 驗收](docs/TESTING.md)及 [WebRTC 實機驗證](docs/verification/webrtc-browser-deployment.md)：測試政策、驗收證據與待測項目。
- [ROADMAP](docs/ROADMAP.md)與 [CHANGELOG](CHANGELOG.md)：規劃及已完成變更。

## 作者與授權條款

- Project Author / Lead Developer：Po-Chun Ruan
- Organization：Academia Sinica（中央研究院）
- Intended License：MIT（待機構確認）
- Copyright：2026 Academia Sinica

機構授權尚待確認；尚未將草稿 `LICENSE` 納入 Preview Candidate，也不表示已正式取得中央研究院的 MIT 開源授權。第三方套件與服務各有其授權或使用條款；預定的 MIT 授權不涵蓋 Gemini API 或其他第三方服務，也不表示這些服務免費或可任意使用。
