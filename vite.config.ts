import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [cloudflare()],
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  // Eye look loads MediaPipe lazily; pre-bundle it at startup so the first G press does not hit a stale dep cache.
  optimizeDeps: { include: ['@mediapipe/tasks-vision'] },
  server: { port: 5173, strictPort: true },
});
