import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import baseConfig from '../../vite.config.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

const config = mergeConfig(baseConfig, {
  ...(process.env.ISSUE41_LOCAL_SMOKE === 'true' ? { envDir: process.env.ISSUE41_RUN_DIR } : {}),
  server: {
    proxy: {
      ...(process.env.ISSUE41_SIGNALING_URL ? {
        '/api/webrtc': {
          target: process.env.ISSUE41_SIGNALING_URL,
          changeOrigin: true
        }
      } : {}),
      '/api': {
        target: `http://127.0.0.1:${process.env.ISSUE41_E2E_API_PORT || '3000'}`,
        changeOrigin: true
      }
    }
  },
  define: { 'import.meta.env.VITE_MEETING_VIEWER_REALTIME_ENABLED': JSON.stringify('false') },
  resolve: {
    alias: {
      ...(process.env.ISSUE41_REAL_GEMINI_AUDIO !== 'true'
        ? { '@google/genai': path.resolve(dirname, '../fixtures/mockGoogleGenAiBrowser.js') } : {})
    }
  }
});

if (process.env.ISSUE41_SIGNALING_URL) {
  const { '/api/webrtc': signalingProxy, '/api': apiProxy, ...otherProxies } = config.server.proxy;
  config.server.proxy = { '/api/webrtc': signalingProxy, ...otherProxies, '/api': apiProxy };
}

export default config;
