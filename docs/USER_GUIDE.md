# Live Translate 使用指南

## 1. 登入並建立會議

使用符合授權規則的 Google Workspace 帳號登入。在會議管理頁建立會議，設定名稱、來源與目標語言、字典和音訊選項，再儲存設定。建立會議或分享連結不會啟動麥克風。

## 2. 設定字典與音訊

在「詞彙設定」選取共用詞彙，或新增、編輯會議詞彙。匯入 CSV、JSON、XLSX 後，確認預覽並儲存；新設定只影響後續內容。翻譯聲音的播放選項與原始麥克風錄音是兩項不同設定，播放聲音也不保證產生可下載的翻譯音訊。

## 3. Host 錄製與繼續

Host 在錄製頁按開始並允許麥克風存取；真實 Gemini Live 翻譯需要在介面提供該次請求使用的 API key。

- **Stop**：暫停錄製，保存目前的本機內容。會議仍可繼續。
- **Continue**：從暫停處恢復錄製。
- **End**：完成會議並固定本機內容的存取期限。

PCM、原始與翻譯音訊、Cue、Transcript、Segment、Checkpoint、Journal、Recovery 保存在 Host 瀏覽器的 OPFS／IndexedDB。請使用原裝置、相同瀏覽器及相同網站來源查看或匯出；清除網站資料、換裝置或使用私密瀏覽，可能無法讀回內容。Safari 私密瀏覽可能無法保存音訊，建議使用一般瀏覽模式，並在離開前確認下載檔案可用。

## 4. Viewer 看字幕

從會議設定複製 Viewer 連結或 QR code。Viewer 經授權後透過 WebRTC DataChannel 看即時字幕；連結不提供 Host 錄音或完整逐字稿。跨網路連線與 TURN 的驗收步驟見 [WebRTC 驗證指南](verification/webrtc-browser-deployment.md)。

## 5. 查看與匯出

Host 可在本機內容的存取期限內查看會議，匯出 TXT／SRT／VTT 與已完整保存的音訊。會議完成後的期限為 30 分鐘；請在期限前確認匯出結果。Supabase 不保存這些錄製內容，無法用來恢復另一裝置上的錄音或字幕。

目前的測試與實機驗收狀態見[測試指南](TESTING.md)。
