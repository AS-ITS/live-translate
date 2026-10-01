# Local device channel PoC verification

This Phase 1 PoC is separate from the cloud Meeting lifecycle, checkpoint, and Viewer routes. It does not migrate data or remove any cloud path.

## Browser-to-device contract

The browser POSTs one immutable JSON packet to `POST /device/operations`: `meetingId`, `operation.operationId`, `chunk.chunkId`, `cue.cueId`, and `checkpoint.checkpointId`. The local service never reads a Vercel page's OPFS, IndexedDB, files, or browser state. The browser must read its own storage and send the immutable packet across the channel.

The file-backed fixture saves a `pending` journal entry before response, then saves `acknowledged`. Exact repeats ACK idempotently; a reused operation or chunk/Cue/checkpoint ID with different canonical content returns `409`, without overwriting first data. A `stop` operation is immutable too; once ACKed, Viewer reads return `409 meeting_stopped`.

## Local run

```bash
LOCAL_DEVICE_POC_STATE_FILE=/private/tmp/live-translate-local-device-poc.json \
LOCAL_DEVICE_POC_ALLOWED_ORIGINS=http://127.0.0.1:5174 \
LOCAL_DEVICE_POC_PORT=4100 \
node scripts/local-device-poc-service.js
```

This HTTP command is a localhost fixture only. Its host and allowlist must be explicit loopback HTTP values; it is prohibited for external acceptance.

For a real device channel, TLS certificate and key paths are both required. The allowlist accepts only approved HTTPS Preview and Production origins:

```bash
LOCAL_DEVICE_POC_STATE_FILE=/private/tmp/live-translate-local-device-poc.json \
LOCAL_DEVICE_POC_TLS_CERT_FILE=/secure/path/device-cert.pem \
LOCAL_DEVICE_POC_TLS_KEY_FILE=/secure/path/device-key.pem \
LOCAL_DEVICE_POC_ALLOWED_ORIGINS=https://preview.example.test,https://app.example.test \
LOCAL_DEVICE_POC_PORT=4100 \
node scripts/local-device-poc-service.js
```

Wildcards, missing configuration, HTTP deployment origins, path-bearing values, and arbitrary request origins are rejected. Anonymous Viewer reads require neither a VPN nor a credential, but must originate from an approved HTTPS origin and reach the TLS device endpoint over the actual network path.

Set `LOCAL_DEVICE_POC_FAIL_POST_AFTER_PENDING_AT=2` to persist the second new operation as `pending`, return `503 simulated_channel_disconnect`, and require the browser to resend that exact packet after reconnect.

## Automated checks

```bash
node --test tests/unit/localDevicePoc.test.js
npx playwright test --config tests/e2e/playwright.config.js tests/e2e/localDevicePoc.spec.js
git diff --check
```

The browser flow uses a distinct preview-like origin. It writes Cue 1, proves anonymous Viewer display and reload, disconnects Cue 2 after `pending`, reconnects and backfills it, restarts the service from the same file, then proves Viewer rejection after stop.

## External-network validation remains manual

Localhost HTTP and the fixture do not prove Vercel/Preview can reach a private device and are prohibited as external acceptance evidence. Before making that claim, run the TLS service on the target Mac or Windows device with exact approved HTTPS Preview and Production origins; submit a real Preview Cue from another network; verify `pending` then `acknowledged`, restart and reload Viewer; capture the reachability method, browser network evidence, device OS, certificate provenance, and commit. Do not treat localhost, a mock, or an undocumented tunnel as cross-network evidence.
