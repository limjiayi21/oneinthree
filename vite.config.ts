import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { fileURLToPath } from 'node:url';

// `npm run dev:local` (mode "offline"; Vite reserves "local") keeps every binding on this machine: no Cloudflare
// workers.dev subdomain needed. Workers AI is then unavailable, so the Worker uses its
// keyword read and line-bank fallbacks. `npm run dev:phone` is the same plus a public https
// tunnel, so a phone can open the game and the phone page (motion sensors need https).
const PUNYCODE = fileURLToPath(new URL('./node_modules/punycode/punycode.js', import.meta.url));

/** Points tr46's require('punycode/') at the npm package (the trailing slash means "the package, not Node's built-in"). */
const punycodeFix = { name: 'punycode-fix', resolveId: (id: string) => (id === 'punycode/' ? PUNYCODE : null) };

export default defineConfig(({ mode }) => ({
  plugins: [{ ...punycodeFix, enforce: 'pre' as const }, cloudflare({ remoteBindings: mode !== 'offline' && mode !== 'phone', tunnel: mode === 'phone' })],
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  // Head look loads MediaPipe lazily; pre-bundle it at startup so the first G press does not hit a stale dep cache.
  optimizeDeps: { include: ['@mediapipe/tasks-vision'] },
  environments: {
    // Browser build only: phone.html is the phone controller page (see docs/INTERACTIVE_CONTROLS_PLAN.md).
    client: { build: { rolldownOptions: { input: { main: 'index.html', phone: 'phone.html' } } } },
    // The Worker: the same alias while Vite pre-bundles the MongoDB driver.
    oneinthree: { optimizeDeps: { rolldownOptions: { plugins: [punycodeFix] } } },
  },
  // The MongoDB driver's URL parser (tr46) does require('punycode/'), which the Worker bundle cannot resolve on its own.
  server: { port: 5173, strictPort: true },
}));
