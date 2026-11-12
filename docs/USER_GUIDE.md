# Live Translate 使用指南

本指南描述 Host Local-only 錄製與 Viewer DataChannel 即時字幕。功能已接入，但 [RC1 正式驗收](TESTING.md#issue-41-rc1-acceptance-status-2026-11-09) 仍為 `BLOCKED`；真實麥克風、跨裝置 Chrome／Safari 與 TURN 流程不可視為已通過。

## 1. 登入與建立會議

使用符合部署環境授權網域規則的 Google Workspace 帳號登入；符合規則的 pending profile 由後端自動啟用，停用帳號仍無法登入。於會議管理建立 Meeting，設定名稱、來源／目標語言、詞彙與音訊選項。儲存後可產生 Viewer 連結或 QR code；建立或分享不會自動啟動麥克風或 Gemini Live。

## 2. 字典與音訊選項

在「詞彙設定」選取共用詞彙或新增／編輯會議詞彙；CSV、JSON、XLSX 匯入預覽後仍須儲存設定。新設定對後續內容生效，已完成 Cue 不因此改寫。

- **播放翻譯聲音**：控制即時翻譯聲音的播放選項，與是否保存原始麥克風聲音不同；開啟播放不保證產生可下載的翻譯音訊。
- **保存原始聲音**：控制 Host 是否在本機保存原始麥克風音訊。未開啟或寫入失敗時，原音下載不可用；這個選項不決定翻譯聲音是否播放。

## 3. Host 錄製與本機資料

在 Host 工作區按「開始錄音」並允許麥克風；需要時按「停止錄音」暫停，再按「繼續」建立後繼 Segment。完成時按「結束會議」。PCM、原音／翻譯音訊、Cue、Transcript、Checkpoint、Journal、Recovery 存於**這台 Host 的瀏覽器 OPFS／IndexedDB**。Supabase 只保留會議 metadata、設定、字典、授權與必要協調 metadata。

清除網站資料、換裝置或換瀏覽器可能失去錄製內容；私密瀏覽關閉後本機資料可能消失。iPhone Safari 私密瀏覽可能在本機音訊寫入時出現 `UnknownError`，請以一般瀏覽模式錄製、匯出，並在離開前確認音訊可讀。不要以清除網站資料作為音訊錯誤排除方式。

## 4. Viewer 分享

在會議設定取得 Viewer 連結／QR code。Viewer 經 WebRTC DataChannel 接收即時字幕與重連 snapshot／replay；Viewer 不接收 Host PCM、錄音或完整 Transcript，也不能在另一裝置取回 Host 本機錄音。跨網路、TURN 與 Safari 實機連線仍需依 [驗證 Runbook](verification/webrtc-browser-deployment.md) 驗收。

## 5. 下載與到期

在**原 Host、原瀏覽器**的會議匯出頁檢查「語音下載」：

1. **原音下載**：會議須啟用「保存原始聲音」，錄音已結束且本機封存片段完整、可讀；未保存或仍在整理時按鈕不提供有效下載。
2. **翻譯音訊下載**：須有 Gemini 翻譯音訊輸出，且本機翻譯音訊片段順序完整、成功封存並可讀；即時「播放翻譯聲音」本身不是下載保證。缺段或寫入失敗時不得下載不完整檔案。

兩者均受本機資料與到期限制；到期、清除網站資料或瀏覽器儲存故障後可能無法下載。字幕 TXT／SRT／VTT 匯出與語音下載是不同能力。僅在頁面實際顯示可用項目且下載成功時，才視為已取得檔案。

## 6. 驗收狀態

Local-only 與 DataChannel 有定向自動化證據；130 分鐘歷史錄製功能判定為 `PASS`，同次 RAM Gate 為 `FAIL`。mobile WebKit「繼續」流程仍有失敗回歸，RC-M1～RC-M6 與 Chrome／Safari 實機矩陣仍未完成，`RC1_RELEASE_VERDICT=BLOCKED`。詳見 [TESTING](TESTING.md)。
