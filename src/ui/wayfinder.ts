/**
 * The way to go: a soft arrow low on the screen pointing toward where she should head (the shop).
 * Faint while she is facing and walking the right way; it grows, brightens and pulses the more
 * she faces or walks away from it.
 */
import { DEG, smoothstep, wrapAngle } from '../player/mathx';

export const WAYFINDER_TUNING = {
  /** How visible it is when everything is right: there, but easy to ignore. */
  base: 0.12,
  /** Facing within this of the target counts as the right way; fully wrong from `faceWrong`. */
  faceOk: 35 * DEG,
  faceWrong: 150 * DEG,
  /** Moving away from the target faster than `awayFrom` m/s starts to show; full at `awayFull`. */
  awayFrom: 0.15,
  awayFull: 0.8,
} as const;

const T = WAYFINDER_TUNING;

/**
 * How obvious the arrow should be, 0..1.
 * relYaw: the target's bearing relative to where she is looking (radians, 0 = straight ahead).
 * approach: how fast she is closing on it (m/s; negative = moving away).
 */
export function wayfinderLevel(relYaw: number, approach: number): number {
  const off = Math.abs(wrapAngle(relYaw));
  const facing = smoothstep((off - T.faceOk) / (T.faceWrong - T.faceOk));
  const away = smoothstep((-approach - T.awayFrom) / (T.awayFull - T.awayFrom));
  return T.base + (1 - T.base) * Math.max(facing, away);
}

const CSS = `
.oit-way{position:fixed;left:50%;bottom:24vh;z-index:40;width:64px;margin-left:-32px;display:grid;justify-items:center;gap:8px;pointer-events:none;opacity:0;transition:opacity .35s ease}
.oit-way[hidden]{display:none}
.oit-way-arrow{width:64px;height:64px}
.oit-way svg{width:100%;height:100%;overflow:visible;filter:drop-shadow(0 1px 3px rgba(0,0,0,.85))}
.oit-way path{fill:none;stroke:var(--oit-way-colour,#e9e4da);stroke-width:5;stroke-linecap:round;stroke-linejoin:round}
.oit-way.is-urgent svg{animation:oit-way-pulse 1s ease-in-out infinite}
.oit-way-label{white-space:nowrap;padding:4px 12px;border-radius:999px;background:rgba(10,12,16,.7);color:var(--oit-way-colour,#e9e4da);font:600 15px/1.2 system-ui,-apple-system,sans-serif;letter-spacing:.04em;text-shadow:0 1px 2px rgba(0,0,0,.9)}
.oit-way-label:empty{display:none}
@keyframes oit-way-pulse{50%{transform:translateY(-6px)}}
@media (prefers-reduced-motion:reduce){.oit-way.is-urgent svg{animation:none}}
`;

export interface Wayfinder {
  /** Point it: relYaw as in wayfinderLevel (positive = target to her left), level 0..1, optional label under it. */
  update(relYaw: number, level: number, label?: string): void;
  hide(): void;
  dispose(): void;
}

export function createWayfinder(): Wayfinder {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const el = document.createElement('div');
  el.className = 'oit-way';
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
  // Two stacked chevrons pointing up (= straight ahead); the arrow rotates to the target's bearing, the label stays upright.
  const arrow = document.createElement('div');
  arrow.className = 'oit-way-arrow';
  arrow.innerHTML = '<svg viewBox="0 0 64 64"><path d="M16 34 L32 18 L48 34"/><path d="M16 50 L32 34 L48 50" opacity=".55"/></svg>';
  const labelEl = document.createElement('span');
  labelEl.className = 'oit-way-label';
  el.append(arrow, labelEl);
  document.body.append(el);
  return {
    update(relYaw, level, label = '') {
      const l = Math.max(0, Math.min(1, level));
      el.hidden = false;
      // Yaw grows turning left; on screen, left of up is a counter-clockwise turn.
      arrow.style.transform = `rotate(${(-wrapAngle(relYaw) / DEG).toFixed(1)}deg) scale(${(0.85 + 0.55 * l).toFixed(3)})`;
      if (labelEl.textContent !== label) labelEl.textContent = label;
      el.style.opacity = (0.15 + 0.8 * l).toFixed(3);
      el.style.setProperty('--oit-way-colour', l > 0.6 ? '#ffd28a' : '#e9e4da');
      el.classList.toggle('is-urgent', l > 0.6);
    },
    hide() {
      el.hidden = true;
      el.classList.remove('is-urgent');
    },
    dispose() {
      el.remove();
      style.remove();
    },
  };
}
