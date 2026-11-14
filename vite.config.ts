import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [cloudflare()],
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { port: 5173, strictPort: true },
});
