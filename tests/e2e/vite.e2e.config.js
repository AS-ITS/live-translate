import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import baseConfig from '../../vite.config.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default mergeConfig(baseConfig, {
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true
      }
    }
  },
  resolve: {
    alias: {
      '@google/genai': path.resolve(dirname, '../fixtures/mockGoogleGenAiBrowser.js')
    }
  }
});
