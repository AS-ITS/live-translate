# Google OAuth 與 Supabase Auth 設定

每個環境的 Google OAuth Client ID 與 Client Secret 必須是同一組；Google 的 callback 指向**該環境 Supabase API**，登入後返回網址則是**該環境前端**。本機環境變數與啟動步驟見 [開發指南](development.md)，雲端清單見 [部署指南](DEPLOYMENT.md)。

## 建立 Google OAuth Client

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 選擇同一個 Project，完成 Google Auth Platform 的 Branding、Audience、必要的測試使用者與網域設定。Internal 僅供所屬 Workspace；External 的 Testing／Production 狀態以 Google 顯示的限制為準。
2. 建立 **Web application** OAuth Client。Authorized JavaScript origins 填實際前端 Origin；Authorized redirect URIs 填對應 Supabase 的 `/auth/v1/callback`。Origin 只有 scheme、host、可選 port；callback 是完整路徑。ID 和 Secret 不可跨 Client 混用。
3. 在各環境 Supabase Auth → Providers → Google 設定**該 Client**的 ID 與 Secret，並在 Supabase Auth → URL Configuration 設 Site URL 與允許的 Redirect URLs。應用程式用目前前端的 `window.location.origin` 作登入返回網址；Preview 網址變動時須更新允許清單。

| 環境 | Authorized JavaScript origin | Google Authorized redirect URI |
| --- | --- | --- |
| Local | `http://127.0.0.1:5173`（依實際 port） | `http://127.0.0.1:54321/auth/v1/callback`（依實際 Supabase `API_URL`） |
| Preview | 實際 Preview HTTPS Origin | 該 Preview Supabase Project 的 `https://<project-ref>.supabase.co/auth/v1/callback` |
| Production | 實際正式網站 HTTPS Origin | 該 Production Supabase Project 的 `https://<project-ref>.supabase.co/auth/v1/callback` |

## Local Google OAuth

1. 查 `supabase/config.toml` 的 `[auth.external.google].client_id`。它必須等於剛建立的 Local Client ID；不要把 Secret 寫進這個檔案。
2. 參照 [`supabase/.env.local.example`](../supabase/.env.local.example)建立 `supabase/.env.local`；若已存在就直接編輯，避免覆蓋。填入**同一 Client**的 `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET`，執行 `chmod 600 supabase/.env.local`。實際檔案由 `.gitignore` 忽略；啟動器要求一般檔案且權限恰為 `600`。
3. 執行 `npx supabase status -o json`，用實際 `API_URL` 加上 `/auth/v1/callback` 設定 Google redirect URI。預設 API port 是 `54321`，若已更改，以 CLI 回報為準。Supabase Local 的 Site URL／Redirect URLs 應允許實際前端 Origin；`npm run start` 不需手動設定 `APP_ORIGIN`，手動 Dev Server 改用其他前端 Origin 時依[開發指南](development.md#方式-b手動-dev-server)核對。
4. 執行 `npm run start -- --check`；它會驗證 Secret 權限、Local Supabase Google provider、URL 與 migration。再依 [完整啟動或 Dev Server 步驟](development.md)登入。

## Preview 與 Production

Preview、Production 各自使用對應的 Supabase Project 與 Google OAuth Client 設定。對每一環境重做上面的 Client、Authorized JavaScript origin、Google callback、Supabase provider ID／Secret、Site URL 與 Redirect URLs 核對。雲端 Google Secret 存在**各自 Supabase Auth provider**，不放 Vercel、不放 `VITE_*`，也不複製 Local 的 `supabase/.env.local`。

Google 登入成功後，後端仍檢查 Profile 與 Meeting 權限。`AUTH_ALLOWED_EMAIL_DOMAINS` 為選填。未設定時不限制 Google 帳號的電子郵件網域；設定後只允許指定網域登入。Google OAuth Audience／Testing 限制不受此變數影響。

## 驗證與排錯

1. Google 提示 `redirect_uri_mismatch`：比對**實際** Supabase API URL 的 callback、Google Client ID，以及該 Client 的 redirect URI；不要拿前端 `/auth/callback` 代替。
2. Supabase 登入後沒有回到網站：核對 Supabase Site URL／Redirect URLs 與實際前端 Origin，包括 scheme 與 port；Preview 網址改變時更新允許清單。
3. `npm run start -- --check` 拒絕啟動：核對 `supabase/.env.local` 存在、Secret 與 ID 相配、權限 `600`，再看 Local Supabase provider 是否啟用。
4. Google 登入成功但 API 回 `403 auth_forbidden`：核對 `AUTH_ALLOWED_EMAIL_DOMAINS`、使用者 email、Profile 狀態與 Meeting membership；Google Audience 設定不能取代後端授權。

參考：[Supabase Google 登入](https://supabase.com/docs/guides/auth/social-login/auth-google)、[Supabase Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)。
