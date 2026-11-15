/**
 * One instruction at a time, top middle of the screen: "Look at the dot", then "← Look left", then "Look right →", then "Now walk".
 * Used at the start of Part 1 only (see src/scenarios/lookGate.ts).
 */
const CSS = `
.oit-look{position:fixed;left:50%;top:13vh;z-index:44;transform:translate(-50%,-6px);padding:12px 26px;border-radius:999px;background:rgba(8,9,12,.62);border:1px solid rgba(233,228,218,.2);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);color:#f3eee4;font:500 26px/1.2 system-ui,-apple-system,sans-serif;letter-spacing:.01em;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .35s ease,transform .35s ease}
.oit-look.is-on{opacity:1;transform:translate(-50%,0)}
.oit-look-arrow{display:inline-block;color:#ffc977;animation:oit-look-nudge 1.1s ease-in-out infinite}
.oit-look-arrow.l{--dx:-6px;margin-right:12px}
.oit-look-arrow.r{--dx:6px;margin-left:12px}
.oit-look-target{position:fixed;left:50%;top:50%;z-index:44;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:#ffc977;box-shadow:0 0 0 2px rgba(0,0,0,.5),0 0 14px rgba(255,201,119,.8);pointer-events:none;opacity:0;transition:opacity .3s ease}
.oit-look-target::after{content:'';position:absolute;inset:-14px;border-radius:50%;border:2px solid rgba(255,201,119,.85);animation:oit-look-ping 1.2s ease-out infinite}
.oit-look-target.is-on{opacity:1}
@keyframes oit-look-ping{0%{transform:scale(.4);opacity:1}100%{transform:scale(1.4);opacity:0}}
@keyframes oit-look-nudge{0%,100%{transform:none}50%{transform:translateX(var(--dx))}}
@media (prefers-reduced-motion:reduce){.oit-look,.oit-look-arrow,.oit-look-target::after{transition:none;animation:none}}
`;

export type LookStep = 'dot' | 'left' | 'right' | 'walk';

export interface LookPrompt {
  show(step: LookStep): void;
  /** Fades it out and removes it. */
  dispose(): void;
}

export function createLookPrompt(): LookPrompt {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const el = document.createElement('div');
  el.className = 'oit-look';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  // The dot to look at: the centre of the view, made big enough to find.
  const target = document.createElement('div');
  target.className = 'oit-look-target';
  target.setAttribute('aria-hidden', 'true');
  document.body.append(el, target);
  let gone = false;

  const arrow = (side: 'l' | 'r', ch: string) => {
    const a = document.createElement('span');
    a.className = `oit-look-arrow ${side}`;
    a.textContent = ch;
    return a;
  };

  return {
    show(step) {
      if (gone) return;
      el.replaceChildren();
      if (step === 'dot') el.append('Look at the dot');
      else if (step === 'left') el.append(arrow('l', '←'), 'Look left');
      else if (step === 'right') el.append('Look right', arrow('r', '→'));
      else el.append('Now walk');
      target.classList.toggle('is-on', step === 'dot');
      requestAnimationFrame(() => el.classList.add('is-on'));
    },
    dispose() {
      if (gone) return;
      gone = true;
      el.classList.remove('is-on');
      target.classList.remove('is-on');
      window.setTimeout(() => {
        el.remove();
        target.remove();
        style.remove();
      }, 400);
    },
  };
}
