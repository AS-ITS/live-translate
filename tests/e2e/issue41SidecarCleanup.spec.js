import { expect, test } from '@playwright/test';

test('repeated Sidecar Pause and Continue cleanup with local-only 410 keeps React mounted', async ({ page }) => {
  const pageErrors = [];
  let localOnlyReads = 0;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/__sidecar_cleanup_probe', (route) => route.fulfill({
    status: 200, contentType: 'text/html', body: '<main id="probe"></main>'
  }));
  await page.goto('/__sidecar_cleanup_probe');
  await page.route('**/api/sessions/session-1', (route) => {
    localOnlyReads += 1;
    return route.fulfill({ status: 410, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'meeting_content_local_only' } }) });
  });
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOMClient } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { useWebRtcDeviceSidecar } = await import('/src/webrtc/useWebRtcDeviceSidecar.js');
    window.RTCPeerConnection = class {};
    window.__sidecarLoads = [];
    window.__sidecarRoot = ReactDOMClient.createRoot(document.getElementById('probe'));
    window.__sidecarRender = (enabled, loadLocalCues) => {
      function Probe() {
        const state = useWebRtcDeviceSidecar({ meetingId: 'meeting-1', enabled,
          lifecycleStatus: enabled ? 'listening' : 'paused', loadLocalCues });
        return React.createElement('span', { id: 'sidecar-state' }, state.value);
      }
      window.__sidecarRoot.render(React.createElement(Probe));
    };
    window.__sidecarPendingLoad = () => new Promise((resolve) => {
      window.__sidecarLoads.push(resolve);
    });
  });

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.evaluate(() => window.__sidecarRender(true, window.__sidecarPendingLoad));
    await expect(page.locator('#sidecar-state')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__sidecarLoads.length)).toBe(cycle + 1);
    await page.evaluate(() => window.__sidecarRender(false, window.__sidecarPendingLoad));
    await expect(page.locator('#sidecar-state')).toHaveText('idle');
    await page.evaluate((index) => window.__sidecarLoads[index]([]), cycle);
  }
  await page.evaluate(() => window.__sidecarRender(true, async () => {
    const response = await fetch('/api/sessions/session-1');
    const body = await response.json();
    throw Object.assign(new Error('Host-only content'), {
      status: response.status, code: body.error.code
    });
  }));
  await expect(page.locator('#sidecar-state')).toHaveText('failed');
  await page.evaluate(() => window.__sidecarRoot.unmount());
  expect(localOnlyReads).toBe(1);
  expect(pageErrors).toEqual([]);
});
