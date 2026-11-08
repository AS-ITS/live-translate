#!/usr/bin/env node
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import Redis from 'ioredis';
import {
  createDefaultWebRtcDeviceAuthorizer,
  createDefaultWebRtcShareResolver,
  createVercelWebRtcSignalingHandler
} from '../api/webrtc/[...path].js';

const signalingPort = Number(process.env.ISSUE41_SIGNALING_PORT || 3001);
const signalingUrl = `http://127.0.0.1:${signalingPort}`;
const redisUrl = process.env.ISSUE41_REDIS_URL;
const supabaseUrl = process.env.ISSUE41_ISOLATED_SUPABASE_URL;
const requestLog = process.env.ISSUE41_SIGNALING_REQUEST_LOG;
if (process.env.ISSUE41_SIGNALING_URL !== signalingUrl
  || !/^redis:\/\/127\.0\.0\.1:\d+(?:\/15)?$/u.test(redisUrl || '')
  || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(supabaseUrl || '')
  || process.env.SUPABASE_URL !== supabaseUrl
  || !process.env.SUPABASE_SECRET_KEY
 || process.env.SUPABASE_JWKS_URL !== `${supabaseUrl}/auth/v1/.well-known/jwks.json`
 || !requestLog?.startsWith(new URL('../test-results/issue41-runner/', import.meta.url).pathname)) {
  throw new Error('Issue #41 signaling harness requires isolated loopback services.');
}

const redis = new Redis(redisUrl, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null
});
redis.on('error', () => {});
await redis.connect();
if (await redis.ping() !== 'PONG') throw new Error('Isolated Redis did not respond to PING.');

const handler = createVercelWebRtcSignalingHandler({
  redis,
  resolveShareToken: createDefaultWebRtcShareResolver(),
  authorizeDevice: createDefaultWebRtcDeviceAuthorizer(),
  iceServers: []
});
const server = http.createServer((request, response) => {
  const path = new URL(request.url, signalingUrl).pathname;
  response.once('finish', () => appendFileSync(requestLog, `${JSON.stringify({
    at: new Date().toISOString(), method: request.method, path, status: response.statusCode
  })}\n`));
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"ok":true}');
    return;
  }
  Promise.resolve(handler(request, response)).catch(() => {
    if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end('{"error":{"code":"webrtc_signaling_unavailable"}}');
  });
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(signalingPort, '127.0.0.1', resolve);
});
process.on('SIGTERM', () => server.close(() => redis.quit()));
process.on('SIGINT', () => server.close(() => redis.quit()));
