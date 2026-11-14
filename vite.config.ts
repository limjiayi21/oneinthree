import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

// `npm run dev:local` (mode "offline"; Vite reserves "local") keeps every binding on this machine: no Cloudflare
// workers.dev subdomain needed. Workers AI is then unavailable, so the Worker uses its
// keyword read and line-bank fallbacks. `npm run dev:phone` is the same plus a public https
// tunnel, so a phone can open the game and the phone page (motion sensors need https).
export default defineConfig(({ mode }) => ({
  plugins: [cloudflare({ remoteBindings: mode !== 'offline' && mode !== 'phone', tunnel: mode === 'phone' })],
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  // Head look loads MediaPipe lazily; pre-bundle it at startup so the first G press does not hit a stale dep cache.
  optimizeDeps: { include: ['@mediapipe/tasks-vision'] },
  environments: {
    // Browser build only: phone.html is the phone controller page (see docs/INTERACTIVE_CONTROLS_PLAN.md).
    client: { build: { rolldownOptions: { input: { main: 'index.html', phone: 'phone.html' } } } },
  },
  server: { port: 5173, strictPort: true },
}));
