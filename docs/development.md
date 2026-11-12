# 本機開發

本指南只說明目前的 Local-only 安裝與啟動。Google 登入的完整設定見 [Google OAuth 指南](GOOGLE_OAUTH_SETUP.md)；雲端環境見[部署指南](DEPLOYMENT.md)。

## 1. 準備工具

- Node.js 22 與 npm（專案目前以 Node.js 22 執行 CI；`package.json` 尚未指定最低版本）。
- Docker、Supabase CLI、`redis-cli` 與 `redis-server`。
- 支援麥克風、Web Audio、OPFS／IndexedDB 和 WebRTC 的瀏覽器。

## 2. 安裝依賴並設定登入

在專案根目錄執行：

```bash
npm ci
```

依 [Google OAuth 指南的 Local 步驟](GOOGLE_OAUTH_SETUP.md#4-local正式本機安裝)設定 `supabase/config.toml` 的 Google Client ID。參照 [`supabase/.env.local.example`](../supabase/.env.local.example) 建立 `supabase/.env.local` 並填入 Local Client Secret；若檔案已存在，請直接編輯，避免覆蓋原有設定。完成後執行：

```bash
chmod 600 supabase/.env.local
```

啟動器要求這個檔案是權限恰為 `600` 的一般檔案。不要將 secret、Gemini API key 或短效 token 提交到版本控制，也不要放入前端 `VITE_` 變數。根目錄 [`.env.example`](../.env.example) 是 Preview／Production 的變數清單；正式本機啟動不需建立根目錄 `.env`。

## 3. 檢查並啟動

```bash
npm run start -- --check
npm run start
```

`--check` 會檢查 Docker、本機 Supabase、OAuth secret、migration 和 loopback Redis；必要時可能啟動 Supabase 或 Redis，因此不是純唯讀。migration 不一致時會停止，**不會自動 reset 資料庫**。`npm run start` 啟動 API（預設 `127.0.0.1:3000`）與 Vite（預設 `127.0.0.1:5173`）；以終端印出的網址為準。`npm run start:local` 使用同一啟動器。

首次建立**可拋棄的空白**本機資料庫時，可執行 `npm run db:start`。`npm run db:reset` 會重建本機資料；不要對已有會議或長時間測試資料的資料庫執行。

啟動器從 Local Supabase CLI 取得本機 URL 與 keys，供前後端使用，並設定本機授權網域。真實 Gemini Live 翻譯需要 Host 在介面提供該次請求的 API key；本機啟動器不會使用雲端 `GEMINI_API_KEY` 代替這個輸入。

## 4. 常見問題

- **無法登入**：核對 Google Client ID、`supabase/.env.local` 的 secret 與權限、本機 callback、允許的返回網址和 Workspace 授權規則；依 [OAuth 排錯步驟](GOOGLE_OAUTH_SETUP.md#7-驗證流程與排錯)檢查。
- **migration 不一致**：先核對本機資料庫與 `supabase/migrations/`，不要為了通過檢查直接 reset 有資料的資料庫。
- **Viewer 無法跨裝置連線**：本機 signaling 需要 Redis；跨網路可能需要 TURN。驗收方法見 [WebRTC 驗證指南](verification/webrtc-browser-deployment.md)。

測試命令與驗收條件見[測試指南](TESTING.md)。資料歸屬與元件設計見[架構總覽](architecture/architecture-overview.md)。
