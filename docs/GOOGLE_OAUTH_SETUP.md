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

1. 在 [Google Cloud Console](https://console.cloud.google.com/)建立自己的 Web application OAuth Client。Authorized JavaScript origin 使用 `http://127.0.0.1:5173`；Authorized redirect URI 預設為 `http://127.0.0.1:54321/auth/v1/callback`（若本機 API port 不同，依實際 URL 調整）。Google 專案仍在 Testing 時，加入自己的測試帳號。
2. 從 [`supabase/.env.example`](../supabase/.env.example)建立私人 `supabase/.env.local`，填入同一個 Client 的 `GOOGLE_CLIENT_ID` 與 `GOOGLE_CLIENT_SECRET`。Windows PowerShell 使用 `Copy-Item supabase/.env.example supabase/.env.local`；Linux Bash 與 macOS Terminal 使用 `cp supabase/.env.example supabase/.env.local`。私人檔案已存在時不要覆寫。
3. `supabase/config.toml` 只使用 `env(GOOGLE_CLIENT_ID)` 與 `env(GOOGLE_CLIENT_SECRET)`，沒有作者的預設值。啟動器使用 Node dotenv 解析，接受正常引號、等號周圍空白、LF 與 CRLF；缺檔、不可讀、缺變數、格式錯誤會分別報錯。不要提交、記錄或貼出憑證。

Linux／macOS：

```bash
chmod 600 supabase/.env.local
npm run start -- --check
```

Windows PowerShell：NTFS 不使用 `chmod 600`。先檢查 ACL，再限制檔案只由本人與必要的系統管理帳號讀取；以下命令移除繼承並移除常見廣泛群組的授權，執行後仍須人工檢查自訂群組。

```powershell
$oauthFile = (Resolve-Path .\supabase\.env.local).Path
icacls $oauthFile /inheritance:r
icacls $oauthFile /grant:r "$($env:USERNAME):(R,W)"
icacls $oauthFile /remove:g '*S-1-1-0' '*S-1-5-11' '*S-1-5-32-545' '*S-1-5-32-546'
Get-Acl $oauthFile | Select-Object -ExpandProperty Access | Format-Table IdentityReference, AccessControlType, FileSystemRights, IsInherited
npm run start -- --check
```

啟動器會拒絕符號連結與一般檔案以外的檔案。Windows 自動 ACL 檢查只辨識 Everyone、Authenticated Users、Users、Guests 等常見廣泛群組；若 PowerShell 無法驗證 ACL，啟動會停止並提示使用 `Get-Acl`／`icacls` 修正。自訂群組的成員與間接權限需人工審查；啟動器不會聲稱它們已通過完整驗證。

執行 `npm run start -- --check` 可讓啟動器將私人設定傳給本機 Supabase CLI，必要時啟動服務並核對 Google provider、URL 與 migration。確認本機 Supabase 的 URL Configuration 允許前端 origin，然後在應用程式進行登入。Preview／Production 必須使用各自的 OAuth 憑證與設定。

本機安裝預設不限制 Google 帳號的 Email 網域。如有組織使用需求，可自行設定允許的網域。`AUTH_ALLOWED_EMAIL_DOMAINS` 未設定或空白時，已通過 Google OAuth 與 Supabase JWT 驗證的帳號可通過後端網域檢查；明確設定後只允許列出的網域。新帳號仍是 `member`，Meeting Ownership 與 RLS 不受影響。

## Preview 與 Production

Preview、Production 各自使用對應的 Supabase Project 與 Google OAuth Client 設定。對每一環境重做上面的 Client、Authorized JavaScript origin、Google callback、Supabase provider ID／Secret、Site URL 與 Redirect URLs 核對。雲端 Google Secret 存在**各自 Supabase Auth provider**，不放 Vercel、不放 `VITE_*`，也不複製 Local 的 `supabase/.env.local`。

Google 登入成功後，後端仍檢查 Profile 與 Meeting 權限。`AUTH_ALLOWED_EMAIL_DOMAINS` 為選填。未設定時不限制 Google 帳號的電子郵件網域；設定後只允許指定網域登入。Google OAuth Audience／Testing 限制不受此變數影響。

## 驗證與排錯

1. Google 提示 `redirect_uri_mismatch`：比對**實際** Supabase API URL 的 callback、Google Client ID，以及該 Client 的 redirect URI；不要拿前端 `/auth/callback` 代替。
2. Supabase 登入後沒有回到網站：核對 Supabase Site URL／Redirect URLs 與實際前端 Origin，包括 scheme 與 port；Preview 網址改變時更新允許清單。
3. `npm run start -- --check` 拒絕啟動：先看錯誤中的 `Expected path`，核對 `supabase/.env.local` 位於目前 clone，ID 與 Secret 非空且相配；macOS／Linux 檢查 `600`，Windows 檢查 NTFS ACL，再看 Local Supabase provider 是否啟用。
4. Google 登入成功但 API 回 `403 auth_forbidden`：核對 `AUTH_ALLOWED_EMAIL_DOMAINS`、使用者 email、Profile 狀態與 Meeting membership；Google Audience 設定不能取代後端授權。

參考：[Supabase Google 登入](https://supabase.com/docs/guides/auth/social-login/auth-google)、[Supabase Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)。
