// Plain Vite (no Worker) for the isolated module harness pages under dev/.
//   npx vite --config vite.harness.config.ts --port 5181
// Set NOHMR=1 to stop the page reloading while files are being edited.
import { defineConfig } from 'vite';
const frozen = process.env.NOHMR === '1';
export default defineConfig({
  server: { strictPort: true, ...(frozen ? { hmr: false, watch: null } : {}) },
});
