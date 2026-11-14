/**
 * Small DOM helpers shared by the HUD and the screens. No framework: plain
 * elements, built with `h()`. Text is always set through text nodes, never
 * innerHTML, so nothing from the server or from evidence.json is parsed as markup.
 */

export type Child = Node | string | number | null | undefined | false | Child[];
export type Attrs = Record<string, unknown>;

function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/**
 * Create an element. `class` sets className, `on<event>` adds a listener,
 * `true` sets an empty attribute, and null / undefined / false are skipped.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function add(parent: Node, ...children: Child[]): void {
  append(parent, children);
}

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
export const clamp01 = (n: number): number => (Number.isFinite(n) ? clamp(n, 0, 1) : 0);

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
}

export function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Force a style flush so a class added next will transition from the current state. */
export function reflow(el: HTMLElement): void {
  void el.offsetWidth;
}

let uid = 0;
export function nextId(prefix: string): string {
  uid += 1;
  return `${prefix}-${uid}`;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el.getClientRects().length > 0,
  );
}

/** Keep Tab inside `container` while it is open. Returns a release function. */
export function trapFocus(container: HTMLElement): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const items = focusables(container);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !container.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !container.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKey, true);
  return () => document.removeEventListener('keydown', onKey, true);
}

/* ------------------------------------------------------------------ fonts */

const FONT_LINK_ID = 'oit-fonts';
const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,300..600;1,6..72,300..600&display=swap';

/**
 * Inject the two webfonts once (Newsreader for headings, statistics and her
 * inner voice; Inter for everything else). The CSS names solid system
 * fallbacks, so the interface is complete without them.
 */
export function ensureFonts(): void {
  if (document.getElementById(FONT_LINK_ID)) return;
  const head = document.head;
  head.appendChild(h('link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }));
  head.appendChild(h('link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: 'anonymous' }));
  head.appendChild(h('link', { id: FONT_LINK_ID, rel: 'stylesheet', href: FONT_HREF }));
}

/* --------------------------------------------------------------- key caps */

export function keycap(label: string): HTMLElement {
  return h('kbd', { class: 'oit-key' }, label);
}

const KEY_NAMES = 'SPACE|SHIFT|ESC|ENTER|TAB|CTRL|ALT|W A S D|WASD';
const KEY_PATTERN = new RegExp(
  [
    // named keys, as the scene directors write them
    `\\b(?:${KEY_NAMES}|Shift|Esc|Space)\\b`,
    // a single letter after an instruction verb: "Press T to type instead"
    `(?<=\\b(?:Press|Hold|Tap|press|hold|tap)\\s)[A-Z0-9]\\b`,
    // a single letter opening an item in a dot-separated list: "SPACE speak  ·  F film  ·  E interact"
    `(?<=·\\s{1,4})[A-Z0-9](?=\\s+[a-z])`,
  ].join('|'),
  'g',
);

function keyLabel(raw: string): string {
  if (raw === 'WASD' || raw === 'W A S D') return 'W A S D';
  return raw.length > 1 ? raw.charAt(0) + raw.slice(1).toLowerCase() : raw;
}

/**
 * Turn key names inside a sentence into key caps: "Hold SPACE to speak",
 * "Press T to type instead", "SPACE speak  ·  F film". Single letters only
 * count after press / hold / tap or at the head of a dot-separated item, so an
 * ordinary capital ("A car passes") is left alone.
 */
export function withKeycaps(text: string): Child[] {
  const out: Child[] = [];
  let last = 0;
  for (const match of text.matchAll(KEY_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const label = keyLabel(match[0]);
    if (label === 'W A S D') out.push(h('span', { class: 'oit-keys' }, label.split(' ').map((k) => keycap(k))));
    else out.push(keycap(label));
    last = index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Context prompts arrive as "E  Ask the clerk for help": a key, a gap, a label.
 * Returns null when the text is not in that shape.
 */
export function splitKeyPrompt(text: string): { key: string; label: string } | null {
  const spaced = /^(\S{1,6})\s{2,}(\S.*)$/.exec(text);
  if (spaced) return { key: spaced[1]!, label: spaced[2]! };
  const named = new RegExp(`^(${KEY_NAMES}|[A-Z0-9])\\s+(\\S.*)$`).exec(text);
  if (named) return { key: named[1]!, label: named[2]! };
  return null;
}
