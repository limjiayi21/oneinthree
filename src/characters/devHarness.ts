/**
 * Character harness (dev/characters.html). Not part of the app bundle.
 *
 * URL parameters (all optional):
 *   build=man|woman  height=1.85  hair=short|buzz|long|ponytail|beanie|hood_down
 *   top=hoodie|jacket|coat|tee|apron  acc=none|tote|backpack|headphones
 *   skin, haircol, topcol, bottomcol, shoecol = hex colours (e.g. topcol=2b2f38)
 *   emotion=<Emotion>  intensity=0..1  posture=<Posture>  gesture=<Gesture>
 *   speed=m/s (walk on the spot)  move=1 (really travel, camera follows)
 *   talk=0..1 | auto   gaze=cam|none|x,y,z
 *   dist=metres from the camera  camh=camera height (1.62)  yaw=orbit degrees
 *   zoom=face|bust|body|game (game = the simulator's 70 degree lens)
 *   blink=0 (no blinking; the default on contact sheets)
 *   t=seconds to fast-forward before the first frame  freeze=1 to hold that frame
 *   look=x,y,z + size=metres (custom framing)  light=lamp|flat  wall=1  ui=0  w,h = canvas size
 *   sheet=1|emotions|gestures|postures|styles  (contact sheets; build/intensity/t apply)
 *
 * From the console: __h.run({emotion:'angry', t:'1'}), __h.snap('name'), __h.batch([...]).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Emotion } from '../../shared/types';
import type { Gesture, HumanOptions, Posture } from '../contracts';
import { createHuman, GESTURE_DURATION, LEAN_WALL_OFFSET, type HumanExt } from './human';

const EMOTIONS: Emotion[] = ['neutral', 'friendly', 'smirk', 'leer', 'mocking', 'annoyed', 'angry', 'contempt', 'sheepish', 'surprised', 'afraid', 'worried', 'relieved', 'determined'];
const POSTURES: Posture[] = ['stand', 'relaxed', 'lean_wall', 'aggressive', 'guarded', 'cower'];
const GESTURES: Gesture[] = ['beckon', 'shrug', 'open_arms', 'point', 'hands_up', 'dismiss', 'lean_in', 'reach', 'wave', 'clutch_bag', 'arms_crossed', 'check_phone', 'look_around'];

type Params = Record<string, string>;

interface Cell {
  human: HumanExt;
  camera: THREE.PerspectiveCamera;
  label: string;
  eye: THREE.Vector3;
  talk: string;
  move: boolean;
  speed: number;
  gazeMode: string;
  gazePoint: THREE.Vector3;
}

const canvas = document.getElementById('view') as HTMLCanvasElement;
const labels = document.getElementById('labels') as HTMLDivElement;
const stats = document.getElementById('stats') as HTMLDivElement;
const panel = document.getElementById('panel') as HTMLDivElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.setPixelRatio(1);
renderer.info.autoReset = false;

let scene = new THREE.Scene();
let cells: Cell[] = [];
let cols = 1;
let rows = 1;
let W = 1200;
let H = 780;
let frozen = false;
let simTime = 0;
let controls: OrbitControls | null = null;
let current: Params = {};
let lastCalls = 0;

function hex(v: string | undefined): number | undefined {
  return v ? parseInt(v.replace('#', ''), 16) : undefined;
}

function optionsFrom(p: Params): HumanOptions {
  const build = (p.build as 'man' | 'woman') ?? 'man';
  return {
    build,
    height: p.height ? parseFloat(p.height) : undefined,
    skin: hex(p.skin),
    hair: hex(p.haircol),
    hairStyle: (p.hair as HumanOptions['hairStyle']) ?? (build === 'man' ? 'buzz' : 'ponytail'),
    top: hex(p.topcol),
    topStyle: (p.top as HumanOptions['topStyle']) ?? (build === 'man' ? 'hoodie' : 'coat'),
    bottom: hex(p.bottomcol),
    shoes: hex(p.shoecol),
    accessory: (p.acc as HumanOptions['accessory']) ?? (build === 'man' ? 'none' : 'tote'),
  };
}

function lights(target: THREE.Scene, mode: string, span: number): void {
  target.add(new THREE.HemisphereLight(0x27344d, 0x2a1c10, mode === 'flat' ? 2.4 : 0.7));
  if (mode === 'flat') {
    const d = new THREE.DirectionalLight(0xfff1e0, 2.2);
    d.position.set(1, 2.5, 3);
    target.add(d);
    return;
  }
  if (span > 0) {
    // contact sheet: one distant lamp so every cell is lit identically
    const d = new THREE.DirectionalLight(0xffc890, 2.6);
    d.position.set(0.9, 4.2, 2.0);
    target.add(d);
    target.add(d.target);
    const bounce = new THREE.DirectionalLight(0xa87850, 0.35);
    bounce.position.set(0.2, -2, 1.5);
    target.add(bounce);
    const rim = new THREE.DirectionalLight(0x5a78a8, 0.5);
    rim.position.set(-2, 2, -3);
    target.add(rim);
    return;
  }
  // a sodium street lamp: above, a little in front and to one side
  const lamp = new THREE.SpotLight(0xffc890, 170, 14, 0.75, 0.6, 2);
  lamp.position.set(1.0, 4.8, 2.0);
  lamp.target.position.set(0, 1.0, 0);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(2048, 2048);
  lamp.shadow.bias = -0.0005;
  lamp.shadow.normalBias = 0.02;
  lamp.shadow.camera.near = 1;
  lamp.shadow.camera.far = 12;
  target.add(lamp, lamp.target);
  // far shop / city glow from behind so the outline never melts into the dark
  const rim = new THREE.DirectionalLight(0x4f6fa0, 0.45);
  rim.position.set(-2.5, 2.2, -3);
  target.add(rim);
  // light coming back up off the lit pavement
  const bounce = new THREE.DirectionalLight(0xa87850, 0.35);
  bounce.position.set(0.2, -2, 1.5);
  target.add(bounce);
}

function frameCamera(cam: THREE.PerspectiveCamera, human: HumanExt, p: Params, origin: THREE.Vector3): THREE.Vector3 {
  const dist = p.dist ? parseFloat(p.dist) : 1.3;
  const camh = p.camh ? parseFloat(p.camh) : 1.62;
  const yaw = ((p.yaw ? parseFloat(p.yaw) : 0) * Math.PI) / 180;
  const zoom = p.zoom ?? 'bust';
  const hh = human.height;
  const eye = new THREE.Vector3(origin.x + Math.sin(yaw) * dist, camh, origin.z + Math.cos(yaw) * dist);
  cam.position.copy(eye);
  const head = new THREE.Vector3(origin.x, hh * 0.925, origin.z + 0.03);
  let look = head;
  let size = 0.36;
  if (zoom === 'bust') {
    look = new THREE.Vector3(origin.x, hh * 0.82, origin.z);
    size = 0.95;
  } else if (zoom === 'body') {
    look = new THREE.Vector3(origin.x, hh * 0.5, origin.z);
    size = hh * 1.2;
  }
  if (p.look) {
    const [lx, ly, lz] = p.look.split(',').map(parseFloat);
    look = new THREE.Vector3(origin.x + lx, ly, origin.z + lz);
    size = p.size ? parseFloat(p.size) : 0.5;
  }
  if (zoom === 'game') {
    cam.fov = 70;
    look = new THREE.Vector3(origin.x, camh, origin.z);
  } else {
    const dd = eye.distanceTo(look);
    cam.fov = (2 * Math.atan(size / 2 / dd) * 180) / Math.PI;
  }
  cam.near = 0.05;
  cam.far = 100;
  cam.lookAt(look);
  cam.updateProjectionMatrix();
  return look;
}

function build(p: Params): void {
  // teardown
  for (const c of cells) c.human.dispose();
  cells = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    }
  });
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06070a);
  labels.innerHTML = '';
  controls?.dispose();
  controls = null;
  current = p;
  simTime = 0;

  W = p.w ? parseInt(p.w, 10) : 1200;
  H = p.h ? parseInt(p.h, 10) : 780;
  renderer.setSize(W, H, false);
  canvas.style.aspectRatio = `${W} / ${H}`;

  const sheet = p.sheet === '1' ? 'emotions' : p.sheet;
  const list: Array<{ label: string; over: Params }> = [];
  if (sheet === 'emotions') for (const e of EMOTIONS) list.push({ label: e, over: { emotion: e } });
  else if (sheet === 'gestures') for (const g of GESTURES) list.push({ label: g, over: { gesture: g } });
  else if (sheet === 'postures') for (const s of POSTURES) list.push({ label: s, over: { posture: s } });
  else if (sheet === 'styles') {
    list.push({ label: 'man buzz hoodie', over: { build: 'man', hair: 'buzz', top: 'hoodie' } });
    list.push({ label: 'man short jacket backpack', over: { build: 'man', hair: 'short', top: 'jacket', topcol: '4a4038', acc: 'backpack' } });
    list.push({ label: 'man beanie jacket headphones', over: { build: 'man', hair: 'beanie', top: 'jacket', topcol: '4a4038', acc: 'headphones' } });
    list.push({ label: 'man short apron', over: { build: 'man', hair: 'short', top: 'apron', topcol: '3d5a4c', height: '1.72' } });
    list.push({ label: 'man hood_down tee', over: { build: 'man', hair: 'hood_down', top: 'tee', topcol: '7a2f2a' } });
    list.push({ label: 'man short coat', over: { build: 'man', hair: 'short', top: 'coat', topcol: '2f2a26' } });
    list.push({ label: 'woman ponytail coat tote', over: { build: 'woman', hair: 'ponytail', top: 'coat', acc: 'tote' } });
    list.push({ label: 'woman long jacket', over: { build: 'woman', hair: 'long', top: 'jacket', topcol: '39445c', acc: 'none' } });
    list.push({ label: 'woman long hoodie backpack', over: { build: 'woman', hair: 'long', top: 'hoodie', topcol: '5c3a44', acc: 'backpack' } });
    list.push({ label: 'woman short tee', over: { build: 'woman', hair: 'short', top: 'tee', topcol: '8a8f98', acc: 'none' } });
  } else list.push({ label: '', over: {} });

  const n = list.length;
  cols = n === 1 ? 1 : n <= 6 ? 3 : n <= 10 ? 5 : n <= 14 ? 7 : 7;
  if (p.cols) cols = parseInt(p.cols, 10);
  rows = Math.ceil(n / cols);
  const spacing = 4;
  lights(scene, p.light ?? 'lamp', n > 1 ? 1 : 0);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(spacing * n + 30, 30), new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.x = (spacing * (n - 1)) / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  list.forEach((item, i) => {
    const q: Params = { ...p, ...item.over };
    if (n > 1 && !p.zoom) q.zoom = sheet === 'emotions' ? 'face' : sheet === 'styles' ? 'body' : 'body';
    if (n > 1 && !p.dist) q.dist = sheet === 'emotions' ? '1.1' : '3.2';
    const human = createHuman(optionsFrom(q));
    const origin = new THREE.Vector3(i * spacing, 0, 0);
    human.root.position.copy(origin);
    scene.add(human.root);
    if (q.posture === 'lean_wall' || q.wall === '1') {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 0.2), new THREE.MeshStandardMaterial({ color: 0x3a312b, roughness: 0.95 }));
      wall.position.set(origin.x, 1.5, -LEAN_WALL_OFFSET * (human.height / 1.85) - 0.1);
      wall.receiveShadow = true;
      scene.add(wall);
    }
    const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
    frameCamera(camera, human, q, origin);
    const cell: Cell = {
      human,
      camera,
      label: item.label,
      eye: camera.position.clone(),
      talk: q.talk ?? '0',
      move: q.move === '1',
      speed: q.speed ? parseFloat(q.speed) : 0,
      gazeMode: q.gaze ?? 'cam',
      gazePoint: new THREE.Vector3(),
    };
    if (cell.gazeMode !== 'cam' && cell.gazeMode !== 'none') {
      const [x, y, z] = cell.gazeMode.split(',').map(parseFloat);
      cell.gazePoint.set(origin.x + x, y, origin.z + z);
    }
    human.debug.noBlink = q.blink === '0' || (n > 1 && q.blink !== '1');
    human.setEmotion((q.emotion as Emotion) ?? 'neutral', q.intensity ? parseFloat(q.intensity) : 1);
    if (q.posture) human.setPosture(q.posture as Posture);
    human.setLocomotion(cell.move ? 0 : cell.speed);
    if (q.gesture) {
      // start the gesture so that the frame at `t` lands at gt (default: mid-gesture)
      const g = q.gesture as Gesture;
      const gt = q.gt ? parseFloat(q.gt) : Math.min(GESTURE_DURATION[g] * 0.5, 1.2);
      const t = q.t ? parseFloat(q.t) : 0;
      (cell as Cell & { gAt?: number; g?: Gesture }).gAt = Math.max(0, t - gt);
      (cell as Cell & { gAt?: number; g?: Gesture }).g = g;
    }
    cells.push(cell);
    if (n > 1) {
      const el = document.createElement('div');
      el.className = 'label';
      el.textContent = item.label;
      el.style.left = `${((i % cols) / cols) * 100}%`;
      el.style.top = `${(Math.floor(i / cols) / rows) * 100}%`;
      el.style.width = `${100 / cols}%`;
      labels.appendChild(el);
    }
  });

  if (n === 1) {
    controls = new OrbitControls(cells[0].camera, canvas);
    const look = frameCamera(cells[0].camera, cells[0].human, p, new THREE.Vector3());
    controls.target.copy(look);
    controls.update();
  }

  frozen = false;
  const t = p.t ? parseFloat(p.t) : 0;
  if (t > 0) step(t);
  else step(1 / 60);
  frozen = p.freeze === '1';
  render();
  panel.style.display = p.ui === '0' || n > 1 ? 'none' : '';
  syncPanel();
}

function tick(dt: number): void {
  simTime += dt;
  for (const c of cells) {
    const ext = c as Cell & { gAt?: number; g?: Gesture };
    if (ext.g && ext.gAt !== undefined && simTime >= ext.gAt) {
      c.human.playGesture(ext.g);
      ext.gAt = undefined;
    }
    if (c.move && c.speed !== 0) {
      c.human.root.position.z += c.speed * dt;
      c.camera.position.z += c.speed * dt;
      if (controls) controls.target.z += c.speed * dt;
    }
    c.eye.copy(c.camera.position);
    c.human.setGaze(c.gazeMode === 'none' ? null : c.gazeMode === 'cam' ? c.eye : c.gazePoint);
    let talk = 0;
    if (c.talk === 'auto') {
      // rough syllable envelope
      const s = simTime;
      const phraseOn = Math.sin(s * 0.9) > -0.6 ? 1 : 0;
      talk = phraseOn * (0.3 + 0.7 * Math.abs(Math.sin(s * 11.3))) * (0.55 + 0.45 * Math.sin(s * 3.1 + 1));
    } else talk = parseFloat(c.talk) || 0;
    c.human.setTalking(talk);
    c.human.update(dt);
  }
}

function step(seconds: number): void {
  const n = Math.max(1, Math.round(seconds * 60));
  for (let i = 0; i < n; i++) tick(1 / 60);
}

function render(): void {
  renderer.info.reset();
  renderer.setScissorTest(true);
  const cw = W / cols;
  const ch = H / rows;
  cells.forEach((c, i) => {
    const cx = (i % cols) * cw;
    const cy = H - (Math.floor(i / cols) + 1) * ch;
    renderer.setViewport(cx, cy, cw, ch);
    renderer.setScissor(cx, cy, cw, ch);
    c.camera.aspect = cw / ch;
    c.camera.updateProjectionMatrix();
    renderer.render(scene, c.camera);
  });
  lastCalls = renderer.info.render.calls;
  stats.textContent = `${lastCalls} draw calls / ${renderer.info.render.triangles} tris  ·  t=${simTime.toFixed(2)}s`;
}

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!frozen) {
    tick(dt);
    controls?.update();
    render();
  } else if (controls) {
    controls.update();
    render();
  }
  requestAnimationFrame(loop);
}

async function snap(name: string, port = 5982): Promise<string> {
  render();
  // composite the cell labels so contact sheets are self-describing
  const flat = document.createElement('canvas');
  flat.width = W;
  flat.height = H;
  const g = flat.getContext('2d')!;
  g.drawImage(canvas, 0, 0);
  if (cells.length > 1) {
    g.font = '15px ui-monospace, Menlo, monospace';
    g.fillStyle = '#e9e4da';
    cells.forEach((c, i) => g.fillText(c.label, ((i % cols) * W) / cols + 8, (Math.floor(i / cols) * H) / rows + 20));
  }
  const data = flat.toDataURL('image/png');
  try {
    const r = await fetch(`http://localhost:${port}/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: data });
    return r.ok ? `saved ${name}` : `save failed ${r.status}`;
  } catch (e) {
    return `save error ${(e as Error).message}`;
  }
}

/* ---------------------------------------------------------------- panel */

function sel(id: string, options: string[], key: string): void {
  const s = document.getElementById(id) as HTMLSelectElement;
  s.innerHTML = options.map((o) => `<option value="${o}">${o || '(none)'}</option>`).join('');
  s.addEventListener('change', () => {
    const p = { ...current };
    if (s.value) p[key] = s.value;
    else delete p[key];
    delete p.t;
    delete p.freeze;
    apply(p, key);
  });
}

function rng(id: string, key: string): void {
  const s = document.getElementById(id) as HTMLInputElement;
  s.addEventListener('input', () => {
    const p = { ...current, [key]: s.value };
    delete p.t;
    delete p.freeze;
    apply(p, key);
  });
}

/** Live-change what can be changed live; rebuild for the rest. */
function apply(p: Params, key: string): void {
  const c = cells[0];
  const live = ['emotion', 'intensity', 'posture', 'gesture', 'speed', 'talk'];
  if (cells.length === 1 && live.includes(key)) {
    current = p;
    if (key === 'emotion' || key === 'intensity') c.human.setEmotion((p.emotion as Emotion) ?? 'neutral', p.intensity ? parseFloat(p.intensity) : 1);
    if (key === 'posture') c.human.setPosture((p.posture as Posture) ?? 'stand');
    if (key === 'gesture' && p.gesture) c.human.playGesture(p.gesture as Gesture);
    if (key === 'speed') {
      c.speed = parseFloat(p.speed) || 0;
      if (!c.move) c.human.setLocomotion(c.speed);
    }
    if (key === 'talk') c.talk = p.talk;
    frozen = false;
  } else build(p);
  history.replaceState(null, '', '?' + new URLSearchParams(p).toString());
}

function syncPanel(): void {
  const set = (id: string, v: string): void => {
    const el = document.getElementById(id) as HTMLSelectElement | HTMLInputElement | null;
    if (el) el.value = v;
  };
  set('p-build', current.build ?? 'man');
  set('p-emotion', current.emotion ?? 'neutral');
  set('p-posture', current.posture ?? 'stand');
  set('p-gesture', current.gesture ?? '');
  set('p-intensity', current.intensity ?? '1');
  set('p-speed', current.speed ?? '0');
  set('p-dist', current.dist ?? '1.3');
  set('p-zoom', current.zoom ?? 'bust');
  set('p-talk', current.talk ?? '0');
  set('p-hair', current.hair ?? '');
  set('p-top', current.top ?? '');
  set('p-acc', current.acc ?? '');
}

sel('p-build', ['man', 'woman'], 'build');
sel('p-emotion', EMOTIONS, 'emotion');
sel('p-posture', POSTURES, 'posture');
sel('p-gesture', ['', ...GESTURES], 'gesture');
sel('p-zoom', ['face', 'bust', 'body', 'game'], 'zoom');
sel('p-talk', ['0', 'auto', '0.3', '0.6', '1'], 'talk');
sel('p-hair', ['', 'short', 'buzz', 'long', 'ponytail', 'beanie', 'hood_down'], 'hair');
sel('p-top', ['', 'hoodie', 'jacket', 'coat', 'tee', 'apron'], 'top');
sel('p-acc', ['', 'none', 'tote', 'backpack', 'headphones'], 'acc');
rng('p-intensity', 'intensity');
rng('p-speed', 'speed');
rng('p-dist', 'dist');
document.getElementById('p-sheet')!.addEventListener('click', () => {
  const p: Params = { sheet: '1', build: current.build ?? 'man', t: '2.5' };
  build(p);
  history.replaceState(null, '', '?' + new URLSearchParams(p).toString());
});
document.getElementById('p-replay')!.addEventListener('click', () => {
  if (current.gesture && cells[0]) cells[0].human.playGesture(current.gesture as Gesture);
});

const api = {
  get cells(): Cell[] {
    return cells;
  },
  renderer,
  get scene(): THREE.Scene {
    return scene;
  },
  get calls(): number {
    return lastCalls;
  },
  run(p: Params): void {
    build(p);
  },
  step,
  render,
  snap,
  /** Build each config, save a screenshot of it. */
  async batch(list: Array<{ name: string; p: Params }>): Promise<string[]> {
    const out: string[] = [];
    for (const it of list) {
      build({ freeze: '1', ui: '0', ...it.p });
      out.push(await snap(it.name));
    }
    return out;
  },
  /** Several time offsets of one config, for motion. */
  async strip(name: string, p: Params, times: number[]): Promise<string[]> {
    const out: string[] = [];
    build({ freeze: '1', ui: '0', ...p, t: String(times[0]) });
    out.push(await snap(`${name}_0`));
    for (let i = 1; i < times.length; i++) {
      step(times[i] - times[i - 1]);
      out.push(await snap(`${name}_${i}`));
    }
    return out;
  },
};
(window as unknown as { __h: typeof api }).__h = api;

build(Object.fromEntries(new URLSearchParams(location.search)));
requestAnimationFrame(loop);
