# WebRTC 正式流程與 Preview 驗證 Runbook

## 證據邊界

正式錄音端與 Viewer 已接入 `subtitle-webrtc/v1` DataChannel fast path。自動化驗證涵蓋授權、participant heartbeat、snapshot、`cue.append`、`cue.update`、same-source replay、暫時斷線 grace、ICE restart、poll/snapshot retry、舊 epoch 隔離、重試耗盡、去重、清理與安全錯誤碼；跨網路、實機 candidate pair、TURN relay、錄音 gap 仍待人工驗證。

Realtime／SSE fallback 仍依賴既有雲端 cue 寫入。本輪沒有完成本機錄製整合，也沒有解決 checkpoint／cue 503，不得把 fallback 可用性或 DataChannel ACK 當成字幕已持久化證據。

## 正式使用者流程

- 錄音端使用目前登入 JWT 與既有 `canRecordMeeting` 規則加入 `device`；不接受 Viewer code/token 取得錄製權限。
- Viewer 從既有 `#viewer?code=` 或 `#viewer?token=` 分享連結自動解析 meetingId，participantId 由瀏覽器產生。
- Device sidecar 失敗只更新分享狀態，不中止 Gemini session 或本機錄音。暫停、停止、離頁、重新啟動會關閉 PeerConnection、DataChannel、polling 與 reconnect timer。
- Viewer 接收 snapshot、`cue.append`、`cue.update` 與 replay；cueId/version merge 防止 DataChannel 與 Realtime/SSE 重複新增。
- `/webrtc-poc.html` 保留為工程測試頁，正式頁面沒有 meetingId、token、participantId 或 signaling URL 輸入欄位。

## 授權與 signaling contract

| 呼叫 | Device | Viewer |
| --- | --- | --- |
| `POST /join` | Bearer JWT + `{ participantId, role: "device" }` | `{ participantId, role: "viewer", shareCode }` 或 `shareToken` |
| `POST /signal` | offer、ICE candidate | answer、ICE candidate |
| `GET /signal` | 已加入 participant | 已加入 participant |
| `POST /leave` | 清除自己的短期 signaling 狀態 | 清除自己的短期 signaling 狀態 |
| `POST /stop` | 可撤銷該 meeting signaling | 固定拒絕 `revoke_forbidden` |

Viewer code 走正式 `resolveCode()`／`short_code_hash`；opaque token 走 `resolveShare()`／`token_hash`。invalid、expired、revoked、meeting mismatch 固定拒絕；已完成或失敗的 meeting 回 `meeting_stopped`。錯誤回應與前端紀錄不得包含憑證。

## Redis 設定格式

Vercel signaling route 使用 Upstash HTTPS REST client：

```text
WEBRTC_SIGNALING_REDIS_URL=https://<upstash-rest-host>
WEBRTC_SIGNALING_REDIS_TOKEN=<upstash-rest-token>
WEBRTC_ICE_SERVERS_JSON=[{"urls":["stun:stun.example.com:3478"]},{"urls":["turns:turn.example.com:5349"],"username":"<short-lived-user>","credential":"<short-lived-credential>"}]
```

保留的 Relay core 使用 ioredis 時必須使用另一組連線設定：

```text
WEBRTC_RELAY_REDIS_URL=rediss://:<password>@<redis-host>:<port>
```

不得把 REST URL/token 傳給 ioredis，也不得把 `rediss://` 傳給 REST adapter。`WEBRTC_ICE_SERVERS_JSON` 是 server-only 設定，只接受 `stun:`、`stuns:`、`turn:`、`turns:` URL；格式錯誤會拒絕啟動 signaling，且不得把 TURN credential 寫入日誌。跨 NAT 或 Wi-Fi／行動網路切換需要可達的 TURN，建議至少提供 `turns:` TLS 端點與短效 credential。未配置並實測 TURN 前，不得宣稱跨網路恢復已完整驗證。

## Preview 部署

本專案沿用 feature branch push 觸發 Vercel Preview，不使用 `--prebuilt`。若之後改用 `--prebuilt`，順序固定為 `vercel pull --environment=preview`、`vercel build`、確認 `.vercel/output`，最後才可 `vercel deploy --prebuilt`。

部署後網址：

```text
正式錄音端：https://<preview-host>/#live?meetingId=<meeting-id>
正式 Viewer：https://<preview-host>/#viewer?code=<share-code>
工程 POC：https://<preview-host>/webrtc-poc.html
```

合法分享 code/token 只在瀏覽器操作，不貼入 issue、公開日誌、截圖標題或報告。

## 一對一實機驗收

1. Device 端登入 Preview，從會議頁選取可錄製 meeting，按「開始錄音」。確認本機錄音持續，詳細狀態出現「字幕分享：連線中／已連線」。
2. Viewer 在另一個網路開啟既有分享連結，不填任何技術欄位。確認依序顯示「連線中／等待錄音開始／已連線」。
3. 說出兩段內容，確認 Viewer 收到 snapshot、append；再觸發修正文句，確認同 cueId 更新且沒有重複列。
4. Viewer 斷網 30 秒後恢復，再測試鎖屏／回前景與 Wi-Fi/4G 切換事件。確認既有字幕保留，狀態依序顯示「正在重新連線」與三秒「已恢復連線」，replay/snapshot 後 Cue 不重複。若六次自動重連用盡，按「重新連線」。
5. Device 執行 pause/resume 與 provider reconnect/rollover，確認 Viewer 透過 snapshot/replay 補齊且不清空既有 Cue。
6. Device 結束錄音，確認 Viewer 顯示「會議已停止」。另用 expired/revoked code 驗證「分享已失效」，且不再發出 snapshot、heartbeat 或 fallback retry。

## `getStats()` 證據

在 Device 與 Viewer 各自的 DevTools Console 執行以下命令並保存 JSON。函式只回傳 candidate-pair 欄位，不包含 JWT 或分享憑證：

```js
const rows = await window.__liveTranslateWebRtcGetStats();
console.log(JSON.stringify(rows, null, 2));
```

local/remote 都是 `host`、`srflx` 或 `prflx` 才記為 direct；任一側是 `relay` 才記為 TURN。沒有兩個不同網路端點及 selected/nominated JSON 時，跨網路與 direct/TURN 狀態維持待驗證。

## 文件核對事項

LAR-44～LAR-51 原文尚未取得，只列為後續文件核對事項，不宣稱已完整對照。這不影響已完成的正式 resolver、Device canRecord、sidecar 與 Viewer 接線。
