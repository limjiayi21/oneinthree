/**
 * The controls, all at once, while she starts walking: a panel low on the left listing what the player can
 * do (keys with the keyboard, the body's gestures with the body; the same lists as the briefing). It
 * fades in, stays a few seconds, and fades out.
 */
import { h, keycap, withKeycaps } from './dom';
import { icon } from './icons';
import type { BriefingControl } from './briefingControls';

const CSS = `
.oit-ctl{position:fixed;left:28px;bottom:22vh;z-index:45;min-width:240px;max-width:min(360px,80vw);padding:14px 18px 16px;border-radius:12px;background:rgba(8,9,12,.78);border:1px solid rgba(233,228,218,.18);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);color:#e9e4da;font:400 15px/1.35 system-ui,-apple-system,sans-serif;pointer-events:none;opacity:0;transform:translateY(8px);transition:opacity .5s ease,transform .5s ease}
.oit-ctl.is-on{opacity:1;transform:none}
.oit-ctl-title{margin:0 0 10px;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:rgba(233,228,218,.6)}
.oit-ctl ul{margin:0;padding:0;list-style:none;display:grid;gap:9px}
.oit-ctl li{display:grid;grid-template-columns:118px minmax(0,1fr);align-items:center;gap:10px}
.oit-ctl-key{display:inline-flex;gap:4px;align-items:center}
.oit-ctl-key .oit-icon{width:22px;height:22px}
@media (prefers-reduced-motion:reduce){.oit-ctl{transition:none;transform:none}}
`;

/** Shows the panel now and hides it after `seconds`. Returns a function that removes it early. */
export function showControlsPanel(controls: readonly BriefingControl[], seconds: number, title = 'Controls'): () => void {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const el = h(
    'div',
    { class: 'oit-ctl', role: 'note', 'aria-label': title },
    h('p', { class: 'oit-ctl-title' }, title),
    h(
      'ul',
      null,
      controls.map((c) =>
        h(
          'li',
          null,
          h('span', { class: 'oit-ctl-key' }, c.key ? (c.key === 'W A S D' ? withKeycaps(c.key) : keycap(c.key)) : c.icon ? icon(c.icon) : null),
          h('span', null, c.label),
        ),
      ),
    ),
  );
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('is-on'));
  let gone = false;
  const remove = (): void => {
    if (gone) return;
    gone = true;
    el.classList.remove('is-on');
    window.setTimeout(() => {
      el.remove();
      style.remove();
    }, 600);
  };
  window.setTimeout(remove, seconds * 1000);
  return remove;
}
