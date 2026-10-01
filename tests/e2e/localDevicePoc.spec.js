import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createLocalDevicePocService, readLocalDevicePocFixture } from '../../scripts/local-device-poc-service.js';

test('preview-origin browser Cue flow reloads, reconnects, restarts, and rejects Viewer after stop', async ({ page, context }) => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'live-translate-local-device-e2e-')), 'fixture.json');
  let deviceOrigin = '';
  const preview = await startPreviewFixture(() => deviceOrigin);
  let device = await createLocalDevicePocService({ stateFile, allowedOrigins: [preview.origin], failPostAfterPendingAt: 2 });
  deviceOrigin = device.origin;
  try {
    await page.goto(`${preview.origin}/writer`);
    await page.getByRole('button', { name: 'Send first Cue' }).click();
    await expect(page.locator('#writer-status')).toHaveText('acknowledged:operation-1');
    const viewer = await context.newPage();
    await viewer.goto(`${preview.origin}/viewer`);
    await expect(viewer.getByText('Cue 1', { exact: true })).toBeVisible();
    await viewer.reload();
    await expect(viewer.getByText('Cue 1', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Send second Cue' }).click();
    await expect(page.locator('#writer-status')).toHaveText('queued:simulated_channel_disconnect');
    await page.getByRole('button', { name: 'Reconnect channel' }).click();
    await expect(page.locator('#writer-status')).toHaveText('acknowledged:operation-2');
    await viewer.getByRole('button', { name: 'Reload Viewer' }).click();
    await expect(viewer.getByText('Cue 2', { exact: true })).toBeVisible();
    expect((await readLocalDevicePocFixture(stateFile)).meetings['meeting-poc'].journal.map((entry) => entry.status)).toEqual(['pending', 'acknowledged', 'pending', 'acknowledged']);
    const port = device.port;
    await device.close();
    device = await createLocalDevicePocService({ stateFile, allowedOrigins: [preview.origin], port });
    deviceOrigin = device.origin;
    await viewer.reload();
    await expect(viewer.getByText('Cue 1', { exact: true })).toBeVisible();
    await expect(viewer.getByText('Cue 2', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stop meeting' }).click();
    await expect(page.locator('#writer-status')).toHaveText('acknowledged:operation-stop-2');
    await viewer.reload();
    await expect(viewer.locator('#viewer-state')).toHaveText('viewer-error:meeting_stopped');
    await viewer.close();
  } finally {
    await device.close();
    await preview.close();
  }
});

async function startPreviewFixture(deviceOrigin) {
  const server = http.createServer((request, response) => {
    const role = new URL(request.url || '/', 'http://preview.test').pathname.slice(1) || 'viewer';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(pageHtml(role, deviceOrigin()));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

function pageHtml(role, deviceOrigin) {
  return `<!doctype html><title>Local Device PoC</title><main id="app"></main><script>
    const deviceOrigin = ${JSON.stringify(deviceOrigin)}, meetingId = 'meeting-poc';
    const packet = (sequence, kind = 'cue.append') => ({ meetingId, operation: { operationId: kind === 'stop' ? 'operation-stop-' + sequence : 'operation-' + sequence, kind }, chunk: { chunkId: 'chunk-' + sequence, sequence, contentHash: 'sha256:' + sequence }, cue: { cueId: 'cue-' + sequence, sequence, sourceText: 'Cue ' + sequence, translatedText: 'Translation ' + sequence }, checkpoint: { checkpointId: 'checkpoint-' + sequence, cueSequence: sequence } });
    const app = document.querySelector('#app');
    const post = async (item) => { const response = await fetch(deviceOrigin + '/device/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) }); const body = await response.json(); if (!response.ok) throw new Error(body.error.code); return body.acknowledgement; };
    if (${JSON.stringify(role)} === 'writer') {
      const queued = []; app.innerHTML = '<button>Send first Cue</button><button>Send second Cue</button><button>Reconnect channel</button><button>Stop meeting</button><p id="writer-status">idle</p>'; const status = document.querySelector('#writer-status');
      const send = async (item) => { if (!queued.includes(item)) queued.push(item); try { const ack = await post(item); queued.splice(queued.indexOf(item), 1); status.textContent = 'acknowledged:' + ack.operationId; } catch (error) { status.textContent = 'queued:' + error.message; } };
      document.querySelector('button:nth-of-type(1)').onclick = () => send(packet(1)); document.querySelector('button:nth-of-type(2)').onclick = () => send(packet(2)); document.querySelector('button:nth-of-type(3)').onclick = async () => { for (const item of [...queued]) await send(item); }; document.querySelector('button:nth-of-type(4)').onclick = () => send(packet(2, 'stop'));
    } else {
      app.innerHTML = '<button>Reload Viewer</button><p id="viewer-state">loading</p><ol id="cues"></ol>'; const load = async () => { const response = await fetch(deviceOrigin + '/device/viewer/' + meetingId); const body = await response.json(), state = document.querySelector('#viewer-state'); if (!response.ok) { state.textContent = 'viewer-error:' + body.error.code; document.querySelector('#cues').replaceChildren(); return; } state.textContent = 'viewer-ready'; document.querySelector('#cues').replaceChildren(...body.cues.map((cue) => { const item = document.createElement('li'); item.textContent = cue.sourceText; return item; })); }; document.querySelector('button').onclick = load; load();
    }
  </script>`;
}
