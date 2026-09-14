import { WebSocketServer } from 'ws';

export function attachExecutionEventsWebSocket({ server, accessControl, sessionReadController, broadcaster, WebSocketServerClass = WebSocketServer } = {}) {
  if (!server || !accessControl || !sessionReadController || !broadcaster) throw new TypeError('WebSocket dependencies are required.');
  const webSocketServer = new WebSocketServerClass({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const match = new URL(request.url || '/', 'http://localhost').pathname.match(/^\/api\/sessions\/([^/]+)\/execution-events$/);
    if (!match) return;
    const sessionId = decodeURIComponent(match[1]);
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit('connection', client, request, sessionId);
    });
  });

  webSocketServer.on('connection', async (client, request, sessionId) => {
    let authenticated = false;
    let unsubscribe = null;
    const authTimeout = setTimeout(() => closeUnauthorized(), 5000);

    client.on('message', async (raw) => {
      if (authenticated) return;
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return closeUnauthorized(); }
      if (message?.type !== 'auth' || typeof message.token !== 'string') return closeUnauthorized();
      try {
        await accessControl.validateRequest({ headers: { authorization: `Bearer ${message.token}` } });
        if (!await sessionReadController.getSession(sessionId)) return closeUnauthorized(1008, 'session_not_found');
      } catch {
        return closeUnauthorized();
      }
      authenticated = true;
      clearTimeout(authTimeout);
      unsubscribe = broadcaster.subscribe(sessionId, (event) => {
        if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
      });
    });

    client.on('close', () => {
      clearTimeout(authTimeout);
      unsubscribe?.();
      unsubscribe = null;
    });

    function closeUnauthorized(code = 1008, reason = 'auth_required') {
      clearTimeout(authTimeout);
      if (client.readyState === client.OPEN || client.readyState === client.CONNECTING) client.close(code, reason);
    }
  });

  return webSocketServer;
}
