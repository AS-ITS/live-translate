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

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 自行建立 **Web application** OAuth Client，取得**自己的** Client ID 與 Client Secret。Authorized JavaScript origin 設為 `http://127.0.0.1:5173`；Authorized redirect URI 使用本機 Supabase API URL 加 `/auth/v1/callback`，預設為 `http://127.0.0.1:54321/auth/v1/callback`。若 Google 專案仍在 Testing，將自己的登入帳號加入測試使用者。
2. 從 [`supabase/.env.example`](../supabase/.env.example)建立 `supabase/.env.local`，填入同一個 OAuth Client 的 `GOOGLE_CLIENT_ID` 與 `GOOGLE_CLIENT_SECRET`。這兩個值由 `supabase/config.toml` 的 `env(...)` 讀取；公開設定沒有預設 Client ID。若私人檔案已存在，請自行補上新變數，不要覆蓋其中其他設定或把憑證寫回公開檔案。
3. `supabase/.env.local` 已被 Git 忽略。macOS／Linux 執行 `chmod 600 supabase/.env.local`；本機啟動器要求一般檔案且權限恰為 `600`。不要提交、記錄或貼出 Client Secret。
4. **首次啟動 Supabase 前**，macOS／Linux 可在目前終端執行 `set -a; . ./supabase/.env.local; set +a`，再執行 `supabase start`（專案 npm 版為 `npx supabase start`）。請確保檔案內容符合 shell 變數語法。也可執行 `npm run start -- --check`，由啟動器讀取私人檔案並在需要時啟動本機 Supabase；它不會使用原作者的 ID 或缺少的變數。Windows PowerShell 可把這兩個變數載入目前終端後啟動 CLI，避免把 Secret 寫入命令歷史。
5. 執行 `supabase status -o json`（npm 版加 `npx`），以實際 `API_URL` 核對 Google redirect URI。`supabase/config.toml` 的 Site URL／Redirect URLs 應允許實際前端 Origin；預設 `http://127.0.0.1:5173` 已設定。`npm run start -- --check` 會檢查兩個變數、權限、Google provider、URL 與 migration；缺少或仍是範本值時會指出需設定的變數。最後依[本機安裝流程](DEPLOYMENT.md#全新安裝本機-supabase)登入；真實 Google 登入仍需人工驗證。

## Preview 與 Production

Preview、Production 各自使用對應的 Supabase Project 與 Google OAuth Client 設定。對每一環境重做上面的 Client、Authorized JavaScript origin、Google callback、Supabase provider ID／Secret、Site URL 與 Redirect URLs 核對。雲端 Google Secret 存在**各自 Supabase Auth provider**，不放 Vercel、不放 `VITE_*`，也不複製 Local 的 `supabase/.env.local`。

Google 登入成功後，後端仍檢查 Profile 與 Meeting 權限。`AUTH_ALLOWED_EMAIL_DOMAINS` 為選填。未設定時不限制 Google 帳號的電子郵件網域；設定後只允許指定網域登入。Google OAuth Audience／Testing 限制不受此變數影響。

## 驗證與排錯

1. Google 提示 `redirect_uri_mismatch`：比對**實際** Supabase API URL 的 callback、Google Client ID，以及該 Client 的 redirect URI；不要拿前端 `/auth/callback` 代替。
2. Supabase 登入後沒有回到網站：核對 Supabase Site URL／Redirect URLs 與實際前端 Origin，包括 scheme 與 port；Preview 網址改變時更新允許清單。
3. `npm run start -- --check` 拒絕啟動：核對 `supabase/.env.local` 存在、Secret 與 ID 相配、權限 `600`，再看 Local Supabase provider 是否啟用。
4. Google 登入成功但 API 回 `403 auth_forbidden`：核對 `AUTH_ALLOWED_EMAIL_DOMAINS`、使用者 email、Profile 狀態與 Meeting membership；Google Audience 設定不能取代後端授權。

參考：[Supabase Google 登入](https://supabase.com/docs/guides/auth/social-login/auth-google)、[Supabase Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)。
