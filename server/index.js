import http from 'node:http';
import { createLiveToken } from './tokenService.js';

const PORT = Number.parseInt(process.env.PORT || '3001', 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://127.0.0.1:5173';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) {
      const error = new Error('Request body too large');
      error.status = 413;
      throw error;
    }
  }

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Invalid JSON body');
    error.status = 400;
    throw error;
  }
}

export async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/api/live-token') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  try {
    const body = await readJson(req);
    const token = await createLiveToken(body);
    sendJson(res, 200, token);
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, status, { error: error.message || 'Internal server error' });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  http.createServer(handleRequest).listen(PORT, '127.0.0.1', () => {
    console.log(`Live Translate API listening on http://127.0.0.1:${PORT}`);
  });
}

