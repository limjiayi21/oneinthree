# Landing page (served at `/about/`)

A self-contained marketing page for One in Three. It is **not** part of the simulator bundle:

- `public/about/` is the whole page: `index.html` plus `assets/` (WebP screenshots of the simulator, each under 200 KB).
  Vite copies `public/` verbatim into `dist/client`, and the Worker's static-assets layer serves
  `dist/client/about/index.html` at `/about/` before the SPA fallback is reached.
  The simulator keeps `/` and `/?demo=1`; `phone.html` and `/api/*` are unchanged.
- No JavaScript libraries: the hero is CSS animation (push-in, crossfade, lamp flicker) plus a small inline rain canvas.
  It respects `prefers-reduced-motion`.
- `index.html` links to the simulator with absolute URLs: `https://oneinthree.nyc/` (full) and
  `https://oneinthree.nyc/?demo=1` (demo). `?demo=1` is read in `src/main.ts` (`demo: params.get('demo') === '1'`) and
  handled by `src/scenarios/womanWalkHome.ts`.
- The hero crops (`hero_*.webp`) have the HUD row and baked thought lines removed; the gallery shots (`shot_*.webp`) are
  the screenshots with their browser and editor strips cropped off.
