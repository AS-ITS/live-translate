# WebRTC 字幕 PoC 驗證與證據

本文件的本輪證據只涵蓋本機合成 fanout。所有 harness 輸出都標記
`environment=local-synthetic`，不代表真實跨網路 WebRTC、瀏覽器、裝置或模型效能。

## 本輪本機驗證

新增檔案：

- `scripts/webrtc-poc-matrix.mjs`，不開啟 socket、不建立 `RTCPeerConnection`、不呼叫真實 WebRTC、模型或 API。
- `docs/verification/webrtc-subtitle-poc.md`，本操作與證據分界說明。

精確命令：

```bash
node scripts/webrtc-poc-matrix.mjs
node --check scripts/webrtc-poc-matrix.mjs
git diff --check
```

第一個命令固定跑 10、50、100 Viewer 三階段，輸出三列 JSON 加 Markdown 表格。每列包含 latency p50/p95、publisher process time、device/process-time proxy、simulated recording gap 與 drop counter。延遲是固定合成 queueing model，process time 是本機 JSON encode/decode 與 fanout 迴圈的 proxy。

本機階段門檻是證據整理門檻，不是跨網路 SLA：10 Viewer p95 ≤ 50 ms、50 Viewer p95 ≤ 100 ms、100 Viewer p95 ≤ 200 ms，且 simulated recording gap/drop 都必須是 0。若改變合成規則或門檻，必須重新執行上述三個命令並保留新的輸出。

## 預期協定與備援邊界

Vercel share authorization/signaling 先驗證 meeting、participant、role 與 `webrtc:signal` scope，再交換 offer、answer、ICE candidate；不可把 share authorization 當成媒體或字幕已送達。DataChannel payload 使用既有 `subtitle-webrtc/v1` envelope，可包含合成字幕 `cue.append`、`snapshot`、`cue.update`、`replay.request` 與 `replay.response`。`cueId`、sequence/revision 與 replay 用來做去重、排序與補發。

Cue envelope 共用 `buildSubtitleEnvelope` 與 `assertEnvelope` contract。`cueId`、meeting scope、message type 與 sequence/revision 必須有效；source 或 translation 至少一側有內容。source-only 與 translation-only 都是合法中間狀態，原文以 `rawSource` 為 canonical value，`refinedSource` 只保留為可選 metadata。完全空白 Cue 會在 transport boundary 被拒絕並產生 `DATA_CHANNEL_ENVELOPE_REJECTED` trace，不可讓例外逃到 Recorder React flow。

既有 Relay core（`server/relay/**`、`src/relay/**`）是 WebRTC 直連不可用時的備援候選，不是本 harness 的網路測試結果，也不把 relay ACK 解讀成所有 Viewer 已渲染或錄音已落盤。連線策略是 direct-first，TURN 只作有限 fallback，並且只在實際 Preview/跨網路測試中記錄是否選到 relay。

## Browser selected candidate-pair 證據

在實際瀏覽器 session 中，等 DataChannel 已開啟後執行並保存 JSON 輸出（不要只截圖）：

```js
const report = [];
for (const [id, pc] of peerConnections) {
  const stats = await pc.getStats();
  const pairs = [...stats.values()].filter((s) => s.type === 'candidate-pair' && (s.selected || s.nominated));
  for (const pair of pairs) {
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    report.push({
      peerId: id,
      pairId: pair.id,
      state: pair.state,
      selected: pair.selected,
      nominated: pair.nominated,
      localCandidateType: local?.candidateType,
      remoteCandidateType: remote?.candidateType,
      currentRoundTripTime: pair.currentRoundTripTime,
      timestamp: pair.timestamp,
    });
  }
}
console.table(report);
```

保存 meeting/session 識別碼、部署 ID、時間戳與上述 selected pair。`host` 或 `srflx` 代表 direct 分類，`relay` 代表 TURN 分類；若 local/remote 一側是 relay，記為 TURN/relay。也保存 candidate pair 原始欄位，避免只依推測的 IP 或 URL 分類。若瀏覽器版本只提供 `nominated` 而沒有 `selected`，要在證據中註明欄位限制。

錄音 gap 必須以 recording chunk/segment 的單調 sequence 或 timestamp 記錄：保存前一個已確認 chunk、下一個收到的 chunk、gap 數量與 reconnect 時間；不能用 DataChannel ACK 取代 recording gap 證據。通訊 fanout drop 與 recording gap 是兩個獨立 counter。

## Preview、跨網路與費用界線

本輪沒有部署 Preview，沒有 Cloudflare，也沒有啟用任何付費方案。因而沒有 Vercel share、瀏覽器 selected candidate pair、跨網路 host/srflx/relay、TURN 或真實錄音 gap 的通過證據。

只有在已部署且記錄了 Preview deployment ID、兩個不同網路端點、browser `getStats()` selected candidate pair、direct/TURN 分類、10/50/100 實際階段結果與 recording gap 原始資料後，才可宣稱跨網路證據通過。`node scripts/webrtc-poc-matrix.mjs` 的成功只能宣稱本機 synthetic protocol fanout 通過，不能填成 Preview 或跨網路通過。
