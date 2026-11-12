# Live Translate

瀏覽器即時語音翻譯與會議字幕工具。Host 取得後端核發的短效 token，直接連接 Gemini Live API；Viewer 透過 WebRTC DataChannel 接收 Host 傳送的即時字幕。

## 正式資料邊界

| 位置 | 責任 |
| --- | --- |
| Host OPFS／IndexedDB | 保存 PCM、原始與翻譯音訊、Cue、Transcript、Checkpoint、Journal 和 Recovery 資料。 |
| Supabase | 保存會議 metadata、設定、字典、帳號、授權、分享與必要的連線協調資料；不保存正式錄製內容。 |
| Viewer WebRTC DataChannel | 接收 Host 的字幕快照、更新與重播；不提供雲端錄音恢復。 |

本機內容只能在原 Host 瀏覽器、相同來源與保留期限內讀回。清除網站資料或換裝置後，不能從 Supabase 還原錄音與字幕。詳見[架構總覽](docs/architecture/architecture-overview.md)。

## 本機啟動

依[開發指南](docs/development.md)準備 Node.js、Supabase、Redis 和 Google Workspace OAuth。OAuth secret 存於 Git 忽略的 `supabase/.env.local`，檔案權限為 `600`；勿將 API key 或短效 token 寫入前端變數或提交至版本控制。

```bash
npm ci
npm run start -- --check
npm run start
```

檢查指令可能啟動本機服務。以終端印出的 Vite URL 為準。實際 Gemini Live 翻譯需要 Host 在介面提供該次請求使用的 API key。

## 使用與文件

1. 登入符合授權規則的 Google Workspace 帳號，建立會議並設定語言與字典。
2. Host 開始錄製；Viewer 使用分享連結觀看即時字幕。
3. Host 可暫停、繼續、結束，並在同一瀏覽器查看或匯出本機內容。

- [產品規格](docs/spec.md) · [架構](docs/architecture/architecture-overview.md) · [API](docs/api.md)
- [使用指南](docs/USER_GUIDE.md) · [開發指南](docs/development.md) · [測試與 RC1 狀態](docs/TESTING.md)
- [ROADMAP](docs/ROADMAP.md) · [CHANGELOG](CHANGELOG.md) · [貢獻指南](CONTRIBUTING.md) · [授權](LICENSE)

RC1 仍有未通過與未完成的驗證；目前狀態以[測試文件](docs/TESTING.md#issue-41-rc1-acceptance-status-2026-11-09)為準。
