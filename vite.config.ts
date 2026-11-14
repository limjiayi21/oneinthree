import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

// `npm run dev:local` (mode "offline"; Vite reserves "local") keeps every binding on this machine: no Cloudflare
// workers.dev subdomain needed. Workers AI is then unavailable, so the Worker uses its
// keyword read and line-bank fallbacks.
export default defineConfig(({ mode }) => ({
  plugins: [cloudflare({ remoteBindings: mode !== 'offline' })],
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { port: 5173, strictPort: true },
}));
