# Local device channel PoC verification

## Vercel Relay PoC boundary

This section documents the testable relay core added in this round. It is not
yet connected to a Vercel Production or Preview route, and it does not change
the recording lifecycle. The automated localhost checks below prove the local
device contract only; they do not prove that a Vercel Preview Function can
reach an Upstash database or a device on another network.

The relay is intentionally narrow:

- Redis **Pub/Sub, not Redis Streams**, is used only for cross-instance routing
  of live subtitle events. It is not a queue, replay log, or source of truth.
- The instance registry stores only routing metadata such as
  `meetingId`, `instanceId`, channel name, expiry, and relay-heartbeat time.
  It must never store a WebSocket/SSE/socket object reference; socket
  references are process-local to the Function instance.
- Permanent subtitle and audio sources remain on the local device. Redis must
  not retain subtitle history. A reconnect gets a local-device snapshot or
  replay, not a Redis replay.
- Relay heartbeat (instance/channel reachability) is separate from the
  recording-lifecycle heartbeat (recorder lease, segment, and meeting expiry).
  Losing relay heartbeat may remove a route; it must not stop or extend a
  recording lifecycle. Lifecycle expiry must not be inferred from Pub/Sub
  traffic.
- A publisher ACK means the relay validated the envelope and the Redis
  `PUBLISH` command completed. It does **not** mean that every Viewer received,
  rendered, or durably stored the event. Pub/Sub delivery can be duplicated or
  lost during expiry/redeploy; clients merge by `cueId` plus monotonic
  revision, and the local source remains authoritative.
- Audio download is a separate future design: a host-authorized range endpoint
  may read the local permanent audio source. This round does not store audio
  in Vercel, Upstash, or another cloud object store.

### Proposed relay envelope and client protocol

The proposed envelope is JSON with `protocolVersion`, `meetingId`,
`channelId`, `requestId`, `cueId`, `revision`, `eventType`, `payload`, and
`sentAt`. `requestId` is a fresh UUID per logical publish and is reused for
all retries of that publish; it is included in logs and test evidence without
transcript or audio content. A retry must be safe when the Viewer receives the
same logical event twice.

The Vercel Node Function uses native-TLS Node `ioredis` clients with a
`rediss://` connection URL: one publisher client and a separate dedicated
subscriber client. The subscriber must remain subscribed to the namespaced
Pub/Sub channel and must reconnect on Function expiry or redeploy. The
registry stores no socket reference. The Upstash REST API and
`@upstash/redis` HTTP client are not appropriate for a continuous Pub/Sub
subscription: REST may document or execute command-style `PUBLISH`, but it
does not provide the persistent cross-instance subscriber connection required
by this relay. See the official
[Upstash ioredis/TLS example](https://upstash.com/docs/redis/search/adapters/ioredis),
[Upstash TLS and security guidance](https://upstash.com/docs/redis/features/security),
[Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi),
[Upstash Pub/Sub publish command](https://upstash.com/docs/redis/sdks/py/commands/pubsub/publish),
and [Upstash use cases](https://upstash.com/docs/redis/overall/usecases).

Suggested timeout/retry defaults for the PoC are `1500 ms` request timeout,
at most two retries with `100 ms` then `250 ms` backoff, and no unbounded
retry loop. A timeout after an unknown `PUBLISH` result is an ambiguous
delivery: retrying can duplicate an event, so the same `cueId`/`revision`
merge rule must be exercised. Do not claim exactly-once delivery.

### Account setup (manual, not automated)

An operator must complete these steps in a disposable Preview project before
external acceptance:

1. Create or select a Vercel project and a Preview deployment. Configure the
   approved Preview origin and deployment protection according to the project
   access policy; do not use an arbitrary public URL. Vercel creates separate
   deployments/URLs for Preview and Production; see [Vercel deployments](https://vercel.com/docs/deployments/overview)
   and [sharing Preview deployments](https://vercel.com/docs/deployments/sharing-deployments).
2. Create an Upstash Redis database, record its REST URL/token in the Vercel
   Preview environment only, and verify the token is absent from browser
   bundles and logs. Do not enable a paid plan for this PoC.
3. Set the PoC's relay channel namespace and short TTL/heartbeat values in the
   Preview environment. Keep recording lifecycle settings separate from relay
   settings.
4. Record account/plan, region, deployment URL, environment-variable names
   (not secret values), and timestamps in the evidence report. A local command
   or a successful deployment alone is not account setup evidence.

### Two-hour cost and quota estimate

This is a planning estimate, not a bill and not a commitment to a paid plan.
For one two-hour meeting, use these conservative assumptions: `E = 7,200`
live relay events (one per second), one `PUBLISH` plus one conservative
delivery-equivalent accounting unit per Viewer per event, and a `2x` command
headroom for reconnects and ambiguous-result retries. This is an upper-bound
planning model; a dedicated subscriber receives Pub/Sub messages on its open
connection and does not issue one REST read per event. Add at most `240`
relay-heartbeat commands (one per 30 seconds); lifecycle heartbeats are
excluded because they are a separate source of truth. For `V` Viewers:

```text
commands ≈ 2 × E × (1 + V) + 240
Upstash request estimate ≈ commands / 100,000 × $0.20
```

| Viewers (`V`) | Conservative commands | Pay-as-you-go request estimate |
| ---: | ---: | ---: |
| 1 | 29,040 | $0.06 |
| 10 | 158,640 | $0.32 |
| 50 | 734,640 | $1.47 |
| 100 | 1,454,640 | $2.91 |

The estimate assumes small JSON envelopes (about 2 KB per routed copy), so
even 100 Viewers are roughly 1.5 GB of relay bandwidth for this meeting,
before provider/network overhead. Upstash currently lists Free as 256 MB and
10 GB monthly bandwidth, and Pay-as-you-go as `$0.20/100K commands`, with the
first 200 GB monthly bandwidth free; verify the live [Upstash Redis pricing](https://upstash.com/pricing)
page before procurement. The PoC must not write subtitle history, so Redis
storage is expected to remain near channel/registry metadata rather than grow
with the meeting transcript.

Vercel cost is account-dependent. If each routed copy becomes a Function
invocation, the conservative request count is `F ≈ E × (1 + V) × 2`; measure
actual invocations, active CPU, provisioned memory, and transfer in the Vercel
Usage dashboard rather than converting this PoC estimate into a promise. The
current public plan page lists Hobby at `$0/month` and Pro at `$20/month` with
`$20` included usage credit; this document does not authorize upgrading. See
[Vercel pricing](https://vercel.com/pricing),
[Vercel Function pricing](https://vercel.com/docs/functions/usage-and-pricing),
and [Function duration limits](https://vercel.com/docs/functions/configuring-functions/duration).

### Required expiry/redeploy/reconnect test matrix

The Preview acceptance record must include each case below, with `requestId`,
deployment ID, timestamps, Viewer count, observed ACK, and resulting source
snapshot. A passed local E2E test cannot substitute for these cases:

- Function expiry: let a relay invocation reach its configured max duration;
  verify the Viewer reconnects, gets a local snapshot, and no finalized Cue
  is treated as durably present solely because Redis ACKed it.
- Redeploy: start a meeting, deploy/redeploy a new Preview revision, and
  verify old registry entries expire, new instances register, and the local
  source remains readable without Redis subtitle history.
- Viewer reconnect: disconnect one Viewer during an event, reconnect it, and
  verify snapshot/replay from the authorized local source plus idempotent
  `cueId`/revision merge; duplicate events must not create duplicate rows.
- Relay heartbeat loss: stop only relay heartbeats and verify routing metadata
  expires without stopping the recording lifecycle. Separately expire the
  recording-lifecycle heartbeat and verify its documented lifecycle transition;
  do not conflate the two signals.

Success requires: no socket reference in registry data, no subtitle/audio
payload retained as history in Redis, ACK semantics match the definition
above, all reconnect/expiry cases pass, and the report clearly labels local
automation versus Preview/Upstash account evidence.

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
