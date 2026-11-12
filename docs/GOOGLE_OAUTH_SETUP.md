# Google OAuth 與 Supabase Auth 安裝

本指南適用於第一次安裝 Live Translate 的 Local、Vercel Preview 與 Production。先完成 Google Cloud 與各環境的 Supabase 設定，再從該環境的實際前端網址登入。Google 驗證成功後，後端仍會檢查 Workspace 網域、Profile 與會議權限。

## 1. 建立 Google Cloud Project 與同意畫面

1. 開啟 [Google Cloud Console](https://console.cloud.google.com/)，建立 Project，或選取要管理此應用 OAuth 的既有 Project。確認後續 Google Auth Platform 與 OAuth Client 都在同一個 Project。
2. 在 **Google Auth Platform → Branding** 填寫應用名稱、使用者支援電子郵件及要求的開發人員聯絡資訊。公開發布時，依畫面要求補齊網域、首頁與政策連結；如需網域驗證，先完成驗證。
3. 在 **Audience** 選擇使用者類型與發布狀態。**Internal** 僅供該 Google Workspace 組織內的使用者，必須使用組織所屬的 Google Cloud Project；其他 Workspace 或個人 Google 帳號無法因為被加入 Live Translate 而跨越此限制。**External / Testing** 是測試狀態；依 Google 對所請求 scope 的規則，測試使用者可能需要加入 Audience 的 Test users。**External / In production** 可供更廣的 Google 帳號進行身分驗證，但敏感或受限制 scope 可能需要 Google 驗證。Google Workspace 管理員仍可封鎖應用。詳見 [Google 的發布狀態與使用者類型](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)。
4. 在 **Data Access** 僅設定實際登入所需的身分 scope（`openid`、`email`、`profile`）；不要為本安裝流程加入不需要的 Google API scope。若 Google Console 顯示不同的已選 scope，以實際 OAuth 請求與 Google 的驗證要求為準。**External / Testing** 僅請求基本身分 scope 時，Google 文件列有測試使用者名單的例外；若畫面仍顯示未授權，先核對實際 scope、Audience 與 Test users。Google 的 Audience 只控制 Google 端可否登入，Live Translate 後端另有網域與資源授權。

## 2. 建立 Web OAuth Client

在 **Google Auth Platform → Clients → Create client** 選 **Web application**。建議 Local、Preview、Production 各建一個 Client，避免環境間 callback 混用，並可分別撤銷或輪替。每個 Client 依下表填入 **Authorized JavaScript origins**（只有 scheme、主機與 port，沒有路徑）與 **Authorized redirect URIs**（完整 callback，須精確相符）。Google 的 `redirect_uri_mismatch` 會比較 Client ID 對應的 redirect URI；scheme、主機、port 與結尾斜線都要核對。[Supabase Google 登入設定](https://supabase.com/docs/guides/auth/social-sign-in/auth-google)、[Google Web OAuth redirect 規則](https://developers.google.com/identity/protocols/oauth2/web-server)。

| 環境 | Authorized JavaScript origins | Authorized redirect URIs |
| --- | --- | --- |
| Local | `http://127.0.0.1:5173` | `http://127.0.0.1:54321/auth/v1/callback` |
| Preview | 實際開啟登入頁的 Preview origin，例如 `https://<preview-host>.vercel.app` | `https://<preview-project-ref>.supabase.co/auth/v1/callback` |
| Production | 正式自訂網域或正式 Vercel origin，例如 `https://<production-host>` | `https://<production-project-ref>.supabase.co/auth/v1/callback` |

Local callback 的 `54321` 來自目前 `supabase/config.toml` 未指定 `[api].port`、而 `scripts/start-local.mjs` 讀取該設定時使用 `54321` 預設值；不是前端 `5173` 或後端 `3000`。如果日後設定改變，以啟動器核對的 `supabase status` API URL 加上 `/auth/v1/callback` 為準。Local Google Client ID 已寫在 `supabase/config.toml`，必須在 Google Cloud 編輯**同一個 Client ID** 的設定；若建立另一個 Local Client，需先由專案維護者另行更新設定，本指南不修改它。Preview URL 若會變動，需逐一加入實際使用的 origin；Google Client 設定不能以 Supabase Redirect URLs 的萬用字元規則代替。

## 3. 分清兩段 redirect

```text
瀏覽器（目前前端 origin）→ Supabase Auth → Google
Google → Supabase Auth callback（填在 Google Cloud）
Supabase Auth → 前端 origin（填在 Supabase Auth URL Configuration）
前端取得 session → GET /api/profile → 應用授權檢查
```

本專案前端呼叫 `signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } })`，並用 PKCE 與 URL 中的登入結果建立 session。因此 Google Cloud 的 **Authorized redirect URI 是 Supabase Auth callback**；Supabase 的 **Site URL / Redirect URLs 是登入完成後允許返回的應用程式網址**。不要把前端首頁填成 Google callback，也不要把 Supabase callback 當成前端 Site URL。`redirectTo` 使用登入當下的實際 origin；若 Vercel Preview 網址變了，允許清單也必須涵蓋新網址。[Supabase Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)。

## 4. Local：正式本機安裝

本機只使用可追蹤的 [`supabase/.env.local.example`](../supabase/.env.local.example) 作格式範例。若尚無 `supabase/.env.local`，可複製 Sample 後填入 Local Google OAuth Client Secret；若檔案已存在，只編輯現有檔案，勿用 Sample 覆蓋。執行 `chmod 600 supabase/.env.local`。根目錄 [`.env.example`](../.env.example) 是 Preview／Production 設定清單，本機 `npm run start` 不需先建立根目錄 `.env`，也不應讀取 Production Supabase URL 或 key。

1. 準備 Node.js、Docker、Supabase CLI 與 Redis，依[開發指南](development.md)安裝依賴。Google Cloud 的 Local Client 必須是 `supabase/config.toml` 現有的 Client ID；它的 JavaScript origin 與 callback 依上表設定。若 Google Project 使用 **External / Testing**，先依實際 scope 與 Google 的要求處理測試使用者。
2. 在 Git 忽略的 `supabase/.env.local` 放入**同一個 Local Client 的 Secret**，格式為 `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET=<你的 Local Client Secret>`。不要把實際值貼到 Markdown、Git、聊天室或任何 `VITE_` 前端變數。執行 `chmod 600 supabase/.env.local`；啟動器要求它是一般檔案且權限**恰為 `600`**，否則會拒絕啟動。`supabase/config.toml` 的 `secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET)"` 會讀取此值。
3. 本機 `supabase/config.toml` 的 Site URL 與 Redirect URLs 已設定 `http://127.0.0.1:5173` 及其路徑。從專案根目錄依序執行：

   ```bash
   npm ci
   npm run start -- --check
   npm run start
   ```

   `--check` 會檢查並可能啟動 Local Supabase／Redis，也會檢查 migration 與 Google provider；它不是純唯讀。啟動後以終端輸出的 Vite URL 開啟網頁。本機登入應使用 `http://127.0.0.1:5173`；若 Vite 因占埠改用其他 port，目前 Supabase URL allowlist 與 Google JavaScript origin 也要對應調整後才能完成 OAuth。不要只更改網址或假設 `localhost` 等同 `127.0.0.1`。
4. 啟動器由 Local Supabase 取得 API URL、anon／service key，提供前端 `VITE_SUPABASE_URL`／`VITE_SUPABASE_PUBLISHABLE_KEY` 及後端 `SUPABASE_URL`／`SUPABASE_SECRET_KEY`／`SUPABASE_JWKS_URL`，並固定 `AUTH_ALLOWED_EMAIL_DOMAINS=as.edu.tw`。因此 Local Google 帳號還需要符合此網域限制；Google OAuth Client 的 Audience 或 Test users 不會放寬後端網域檢查。

## 5. Preview／Production：各環境分開配置

逐環境參照根目錄 [`.env.example`](../.env.example) 設定 Vercel 變數；Sample 標明必要性、適用環境與 secret 邊界。Preview 與 Production 的 Google OAuth **Client Secret 填在各自 Supabase 專案的 Authentication → Providers → Google**，與該環境的 Client ID 成對；勿填在 Vercel `VITE_` 變數或提交到 Sample。本機 Secret 才放在 `supabase/.env.local`。

每個環境先建立或選定**自己的 Supabase Project**，確認 Project URL 與 project ref。對該環境重複以下步驟；不要讓 Preview 指向 Production Project。若使用 Supabase Preview branch，也需以**實際分支的 Auth URL 與設定**逐項核對，不能假設與主 Project 相同。

1. 在 Google Cloud 建立該環境的 Web OAuth Client，把該環境的實際前端 origin 放進 **Authorized JavaScript origins**，並把對應 Supabase Dashboard **Authentication → Providers → Google** 顯示的 callback URL 放進 **Authorized redirect URIs**。一般 Supabase Project 的形式是 `https://<project-ref>.supabase.co/auth/v1/callback`；以 Dashboard 顯示值為準。
2. 在**同一個 Supabase Project** 的 **Authentication → Providers → Google** 啟用 Provider，填入此 Client 的 **Client ID** 與 **Client Secret** 並儲存。Client Secret 只留在 Supabase Dashboard 的安全設定，不放進 Vercel `VITE_` 變數。Client ID 與 Secret 必須出自同一個 Google OAuth Client。
3. 在 **Authentication → URL Configuration** 設 **Site URL**：Preview 專案填固定的 Preview 入口網址；Production 專案填正式對外網址。**Redirect URLs** 加入實際會從該 Supabase Project 登入的完整前端 origin（必要時含路徑）。Production 優先列明確網址；Preview 如使用變動的 Vercel URL，可依[Supabase 的 Vercel Preview 萬用字元範例](https://supabase.com/docs/guides/auth/redirect-urls#vercel-preview-urls)加入受限 pattern，並核對它只涵蓋預期的 Preview 網域。Site URL 是沒有 `redirectTo` 時的預設值；本專案有傳 `window.location.origin`，仍須把該**實際網址**列為允許 redirect。正式自訂網域與 `*.vercel.app` 網址若都用來登入，應分別核對。
4. 在 Vercel 對應的 **Preview** 或 **Production** scope 設定：瀏覽器端 `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`；後端 `SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`SUPABASE_JWKS_URL`、`AUTH_ALLOWED_EMAIL_DOMAINS`、`APP_ORIGIN`。同一部署的前後端 Supabase URL、key 與 JWKS 必須屬於**同一個環境 Project**；`APP_ORIGIN` 應對應使用者實際進入的站點來源。部署後以實際 Vercel URL 驗證登入，若環境變數調整後須重新部署才會反映在前端 build。詳見[部署指南](DEPLOYMENT.md)。

共用一個 Google Client 雖可加入多個 callback 與 origin，但任何 Client Secret 輪替、誤設 redirect 或撤銷都會影響所有共用環境，也較難從 Google 設定辨識是哪個環境；建議分開。Supabase Project、Site URL 與應用授權也必須保持環境隔離。不要將實際 Secret、access token、service key 或私密憑證值寫入文件、工單或前端變數。

## 6. 登入後的權限模型

1. **Google 身分驗證**只確認 Google 帳號可以經由所選 Client 登入 Supabase，並產生該 Supabase Project 的使用者 session。Internal／External、Testing／Production 在 Google 端決定可否進入這一步。
2. **後端網域限制**會驗證 Supabase access token，並以 `AUTH_ALLOWED_EMAIL_DOMAINS` 核對 email 網域；不符合者得到 `403 auth_forbidden`。Local 啟動器固定 `as.edu.tw`；雲端需為各環境明確設定。Google 的 `hd` 提示或 Audience 不能取代後端檢查。
3. **Supabase Profile**：`auth.users` 觸發器會建立 `member`、`pending` Profile。後端在通過網域檢查的請求中，才以 service-role-only RPC 將 `pending` 啟用為 `active`；`disabled` 不會自動恢復。Profile 缺失或啟用失敗會阻擋登入後的私有 API，不應把 Google 登入成功視為已授權。
4. **角色與會議權限**：`member` 是一般角色，`super_admin` 是管理角色，兩者不能由 Google 登入自行升權。Meeting 的 owner 與 `meeting_members` membership 另行判定可見、管理及錄製權限；錄製還須符合 `can_record`。登入成功或 Profile `active` 不代表有權操作既有 Meeting。具體端點仍以其授權檢查為準。

前端取得 session 後會呼叫 `GET /api/profile`；只有 Profile 檢查成功才進入 Workspace。遇到網域拒絕時，登入頁會顯示目前帳號與「切換 Google 帳號」；切換動作會要求 Google 顯示帳號選擇。參照 `src/components/AuthGate.jsx`、`server/accessControl.js`、`server/profileService.js` 與 `supabase/migrations/20261002000000_domain_auto_activation.sql`。

## 7. 驗證流程與排錯

1. 在各環境確認 Google OAuth Client 所屬 Project、Client ID、JavaScript origin 與該 Supabase Project 的 callback。確認 Supabase Google Provider 已啟用、Site URL／Redirect URLs 包含當前前端 origin，並確認 Vercel 前後端連到同一 Supabase Project。
2. 開啟**該環境實際**前端 URL，按「使用 Google 登入」，完成 Google 授權；確認返回原先的前端 origin，頁面不再顯示登入按鈕。用符合後端網域的帳號確認 `GET /api/profile` 通過，能進入 Workspace。若要驗證 Meeting 操作，需再以 owner／已授權 member 測試相應功能；只測登入不能證明 Meeting 授權。Local 先跑 `npm run start -- --check`，再跑 `npm run start`。

| 現象 | 核對與處理 |
| --- | --- |
| `redirect_uri_mismatch` | 從 Google 錯誤頁的 `redirect_uri` 查實際 callback，確認它在**發出請求的 Client ID** 的 Authorized redirect URIs 中完全相同；Local 核對 Supabase API port，雲端核對 project ref。 |
| Google 登入後返回錯誤網址 | 核對瀏覽器登入時的 `window.location.origin`、該 Supabase Project 的 Site URL 與 Redirect URLs；Vercel Preview 網址變動後更新允許清單，確認不是指到另一環境。 |
| Google Provider 未啟用 | 雲端檢查目標 Supabase Project 的 **Authentication → Providers → Google**；Local 檢查 `supabase/config.toml` 與 `npm run start -- --check` 輸出的 provider 檢查結果。 |
| Client ID／Secret 不一致 | 在 Google Cloud 與同一環境 Supabase 設定中核對 Client ID 來源；Local 核對現有 `config.toml` ID 與 `.env.local` 的 Secret 來自同一 Client。需要輪替時在安全設定中更新，勿在日誌或工單貼出值。 |
| Google 登入成功但 Live Translate 無權限 | 檢查 `AUTH_ALLOWED_EMAIL_DOMAINS`、目前登入 email、Profile 是否為 `active`、角色，以及該 Meeting 的 owner／membership／`can_record`。`403 auth_forbidden` 常是網域或停用帳號；Profile 缺失／啟用失敗需由管理員查明。 |
| Local Google OAuth 無法完成 | 核對 `supabase/.env.local` 為 Git 忽略的一般檔案且 mode `600`、Local Client 的 origin／callback、`127.0.0.1:5173` 是否被 Vite 改 port，以及 `npm run start -- --check` 所報的 Supabase／migration／Redis 錯誤。 |
| Preview／Production 使用錯誤 Supabase Project | 核對該 Vercel scope 的 `VITE_SUPABASE_URL`、`SUPABASE_URL`、JWKS、key 所屬 project ref；核對 Google callback 與 Dashboard 中的目標 Project，修正後重新部署。 |
| OAuth 測試使用者未被 Google 授權 | 核對 Audience 的 Internal／External、Testing／In production、實際 scope 與 Test users；Workspace 管理員也可能限制第三方應用。Google 端放行後仍須通過 Live Translate 的網域與 Profile 檢查。 |

本文件依 [Supabase Google 登入](https://supabase.com/docs/guides/auth/social-sign-in/auth-google)、[Supabase Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls) 與 [Google OAuth 發布狀態](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview) 核對。外部 Dashboard 的實際設定需由部署操作者在各自帳號中確認。
