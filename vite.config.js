import { execFile } from 'node:child_process';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const env = loadEnv(process.env.NODE_ENV || 'development', process.cwd(), '');

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'live-translate-dev-shortcuts',
      configureServer(server) {
        server.bindCLIShortcuts({
          print: false,
          customShortcuts: [
            {
              key: 'o',
              description: 'open in the default browser',
              action() {
                const url = server.resolvedUrls?.local?.[0] || server.resolvedUrls?.network?.[0];
                if (!url) {
                  server.config.logger.warn('No Vite URL is available to open.');
                  return;
                }

                openInDefaultBrowser(url, (error) => {
                  if (error) {
                    server.config.logger.error(`Could not open the browser automatically: ${error.message}`);
                    server.config.logger.info(`Open this URL manually: ${url}`);
                  }
                });
              }
            }
          ]
        });
      }
    }
  ],
  build: {
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) {
            return undefined;
          }

          if (id.includes('/node_modules/@google/genai/')) {
            return 'vendor-gemini';
          }

          if (id.includes('/node_modules/opencc-js/')) {
            return 'vendor-opencc';
          }

          if (id.includes('/node_modules/ag-grid-community/') || id.includes('/node_modules/ag-grid-react/')) {
            return 'vendor-ag-grid';
          }

          if (id.includes('/node_modules/qrcode/')) {
            return 'vendor-qrcode';
          }

          if (id.includes('/node_modules/downshift/')) {
            return 'vendor-downshift';
          }

          if (id.includes('/node_modules/lucide-react/')) {
            return 'vendor-icons';
          }

          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/')) {
            return 'vendor-react';
          }

          return 'vendor';
        }
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: env.dev_backend_origin || 'http://127.0.0.1:3000',
        changeOrigin: true
      }
    }
  }
});

function openInDefaultBrowser(url, callback) {
  if (process.platform === 'darwin') {
    execFile('open', [url], callback);
    return;
  }

  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url], callback);
    return;
  }

  execFile('xdg-open', [url], callback);
}
