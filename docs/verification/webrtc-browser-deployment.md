# WebRTC Host／Viewer Preview 驗證 Runbook

## 版本與證據邊界

本文件適用 Issue #41 整合後的 Host Local-only Meeting。早期 WebRTC PoC／Cloud Recording 時期的「Realtime／SSE fallback 依賴雲端 Cue 寫入」、「尚未完成本機錄製整合」與 checkpoint／cue 503 結論**只屬整合前歷史驗證**，不代表目前產品狀態。現行 Host 在 OPFS／IndexedDB 保存 PCM、音訊、Cue、Transcript、Checkpoint、Journal、Recovery；Supabase 僅保存 metadata、設定、字典、授權及必要協調 metadata。DataChannel ACK 不等於本機持久化成功。

已通過的定向自動化測試涵蓋授權、participant heartbeat、snapshot、`cue.append`、`cue.update`、same-source replay、斷線 grace、ICE restart、poll／snapshot retry、舊 epoch 隔離、去重與清理；詳見 [TESTING](../TESTING.md#webrtc-正式流程)。這些是當時的測試結果，**尚未等同目前版本的跨網路 Safari 實機驗收**。RC-M1～RC-M6、Chrome／Safari 實機矩陣及 TURN candidate pair 仍按 [RC1 狀態](../TESTING.md#issue-41-rc1-acceptance-status-2026-11-09) 標示 `NOT_TESTED`／`BLOCKED`，不可由單元測試推定通過。

## 現行正式流程

1. Host 使用登入 JWT 與 `canRecordMeeting` 授權加入 `device`；Viewer code／token 不授予錄製權。Host 的字幕 Cue 由本機持久化路徑產生，WebRTC sidecar 以 DataChannel 發送 snapshot、append、update 與 replay。
2. Viewer 從 `#viewer?code=` 或 `#viewer?token=` 分享連結解析 Meeting，瀏覽器產生 participantId；透過 `/api/webrtc/:meetingId` signaling 建立 PeerConnection／DataChannel，收到字幕後按 cueId／version 合併並去重。Viewer 不下載 Host 的 PCM、音訊或 Transcript。
3. Sidecar 失敗更新分享狀態，不代表 Gemini session 或 Host 本機錄音自動停止。Pause、Stop、離頁與重新啟動須清理 PeerConnection、DataChannel、polling 與 reconnect timer；重新連線後查 snapshot／replay 是否補齊、不重複。

工程 `/webrtc-poc.html` 僅供本機 Vite 開發驗證，Preview／Production build 不包含該頁。signaling 端點 `POST /join`、`POST /signal`、`GET /signal`、`POST /leave`、`POST /stop` 的授權與狀態依現行 API；不要把 PoC 當成使用者流程。

## Preview signaling 設定

Vercel signaling 使用 Redis HTTPS REST：

```text
WEBRTC_SIGNALING_REDIS_URL=https://<upstash-rest-host>
WEBRTC_SIGNALING_REDIS_TOKEN=<upstash-rest-token>
WEBRTC_ICE_SERVERS_JSON=[{"urls":["stun:stun.example.com:3478"]},{"urls":["turns:turn.example.com:5349"],"username":"<short-lived-user>","credential":"<short-lived-credential>"}]
```

保留的 Relay core 使用 ioredis 時才使用 `WEBRTC_RELAY_REDIS_URL=rediss://:<password>@<redis-host>:<port>`；不可互換 REST 與 ioredis 連線值。`WEBRTC_ICE_SERVERS_JSON` 僅設於 server，僅接受 `stun:`、`stuns:`、`turn:`、`turns:` URL。未配置並實測 TURN 前，跨網路恢復維持未驗證。

## Preview 與一對一實機驗收

Preview 使用 `npm run deploy:preview`（`vercel deploy --yes` 與 preflight），不使用 `--prebuilt`。部署後的 Host／Viewer 路徑：

```text
Host:   https://<preview-host>/#live?meetingId=<meeting-id>
Viewer: https://<preview-host>/#viewer?code=<share-code>
```

1. Host 登入 Preview，從可錄製 Meeting 按「開始錄音」，核對本機錄音與字幕分享狀態；Viewer 於第二裝置、另一網路以分享連結加入，不輸入技術欄位。
2. 說兩段內容，確認 Viewer snapshot、append 與同 cueId update；斷網 30 秒後恢復，再測鎖屏／回前景和 Wi-Fi／行動網路切換，確認 replay 無遺漏或重複。
3. Host 執行 Pause／Continue、provider reconnect／rollover、End；核對 Viewer 狀態與本機 Cue／Checkpoint／Journal 回讀。Expired／revoked share 應顯示失效且停止 retry。各步記錄裝置、OS、瀏覽器版本、時間與去識別證據；未執行仍為 `NOT_TESTED`。
4. 在 Host 與 Viewer 的 DevTools 各執行 `await window.__liveTranslateWebRtcGetStats()`，保存 selected／nominated candidate pair 的去敏 JSON。任一側 candidate type 為 `relay` 才可記 TURN；缺不同網路端點或候選證據時保持待驗證。Safari 實機需獨立執行及判定，不可用 mobile WebKit 自動化結果替代。

不得在 issue、截圖標題或報告揭露 share code／token、JWT、TURN credential 或 API key。LAR-44～LAR-51 原文尚未取得，僅列為後續文件核對事項，不宣稱已逐項對照。
