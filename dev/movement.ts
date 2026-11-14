/**
 * Movement harness: the player controller and the NPC controller on a flat
 * test street, with a stub Human (a capsule with a nose).
 *
 *   npx vite --config vite.harness.config.ts --port 5183
 *   http://localhost:5183/dev/movement.html
 *
 * URL parameters
 *   body=woman|bystander   which first-person body                (woman)
 *   nolock=1               keys work without pointer lock, drag to look
 *   paused=1               the sim only advances through __sim.step()
 *   engine=stub            use the local Engine stub instead of src/engine/engine.ts
 *   human=real             carry src/characters/human.ts models instead of the stub capsules
 *   px, pz, pyaw, ppitch   player pose (metres, degrees)
 *   ax, az, ayaw           NPC A pose;  bx, bz, byaw  NPC B pose
 *   a=<behaviour>          idle|goTo|path|walkAlongside|followBehind|block|closeIn|backAway|leave
 *   b=<behaviour>          same, for NPC B
 *   gap, side, speed       parameters for a= / b=
 *   tx, tz                 target point for goTo / leave
 *   tension=0..1  phone=1  map=0
 *   scenario=<name>        alongside|follow|block|route|posts|closein|squeeze   (preset of the above)
 *
 * window.__sim            step(), keys(), look(), state(), events, checks.*, runChecks()
 */

import * as THREE from 'three';
import type { Engine, Human, HumanOptions, NpcBehaviour, Rect } from '../src/contracts';
import { NPC_MODEL_YAW_OFFSET, createNpc, type NpcController } from '../src/characters/npc';
import { DEG, clamp, wrapAngle, yawOf } from '../src/player/mathx';
import { PLAYER_TUNING, createPlayer, type PlayerController } from '../src/player/player';

/* ------------------------------------------------------------------ params */

const qs = new URLSearchParams(location.search);
const num = (k: string, d: number): number => {
  const v = qs.get(k);
  const n = v === null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const flag = (k: string): boolean => qs.get(k) === '1' || qs.get(k) === 'true';
const NOLOCK = flag('nolock');
const PAUSED = flag('paused');
const BODY = qs.get('body') === 'bystander' ? 'bystander' : 'woman';

/* ------------------------------------------------------------------ engine */

type HarnessEngine = Engine & { renderOnce?: (dt?: number) => void };

function createStubEngine(canvas: HTMLCanvasElement): HarnessEngine {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x05080b, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 300);
  camera.rotation.order = 'YXZ';
  scene.add(camera);
  const subs = new Set<(dt: number, elapsed: number) => void>();
  let running = false;
  let raf = 0;
  let last = 0;
  let elapsed = 0;
  const resize = () => {
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);
  const frame = (dt: number) => {
    for (const fn of [...subs]) fn(dt, elapsed);
    renderer.render(scene, camera);
  };
  const loop = (ms: number) => {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    const now = ms / 1000;
    const dt = Math.min(0.05, last === 0 ? 1 / 60 : Math.max(0, now - last));
    last = now;
    elapsed += dt;
    frame(dt);
  };
  return {
    renderer,
    scene,
    camera,
    start() {
      if (running) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    onUpdate(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    setFear() {},
    pulse() {},
    renderOnce(dt = 0) {
      elapsed += dt;
      frame(dt);
    },
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      renderer.dispose();
    },
  };
}

async function makeEngine(canvas: HTMLCanvasElement): Promise<{ engine: HarnessEngine; kind: 'real' | 'stub' }> {
  if (qs.get('engine') !== 'stub') {
    // Present only once the engine module has landed; the glob is empty before that.
    const mods = import.meta.glob('../src/engine/engine.ts');
    const load = mods['../src/engine/engine.ts'];
    if (load) {
      try {
        const m = (await load()) as { createEngine: (c: HTMLCanvasElement) => Engine };
        return { engine: m.createEngine(canvas) as HarnessEngine, kind: 'real' };
      } catch (err) {
        console.warn('[harness] src/engine/engine.ts failed, falling back to the stub', err);
      }
    }
  }
  return { engine: createStubEngine(canvas), kind: 'stub' };
}

/* ------------------------------------------------------------- test street */

const rect = (xa: number, xb: number, za: number, zb: number): Rect => ({
  minX: Math.min(xa, xb),
  maxX: Math.max(xa, xb),
  minZ: Math.min(za, zb),
  maxZ: Math.max(za, zb),
});

const BOUNDS = rect(-12, 12, -140, 8);
const CAR = { width: 1.9, length: 4.6 };
/** Right-curb car that the `route` check sends an NPC across. */
const ROUTE_CAR = rect(2.5, 2.5 + CAR.width, -6, -6 - CAR.length);

function buildStreet(scene: THREE.Scene): { colliders: Rect[]; group: THREE.Group } {
  const group = new THREE.Group();
  group.name = 'test-street';
  scene.add(group);
  const colliders: Rect[] = [];

  const lit = (color: number, rough = 0.9) => new THREE.MeshStandardMaterial({ color, roughness: rough });
  const box = (r: Rect, height: number, color: number, collide = true, y0 = 0): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(r.maxX - r.minX, height, r.maxZ - r.minZ), lit(color));
    m.position.set((r.minX + r.maxX) / 2, y0 + height / 2, (r.minZ + r.maxZ) / 2);
    group.add(m);
    if (collide) colliders.push(r);
    return m;
  };

  // ground: a paving grid so motion reads, darker road down the middle
  const grid = (base: string, line: string, cell: number): THREE.CanvasTexture => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = base;
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = line;
    g.lineWidth = 3;
    g.strokeRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.repeat.set(1 / cell, 1 / cell);
    return t;
  };
  const plane = (r: Rect, tex: THREE.CanvasTexture, y: number) => {
    const w = r.maxX - r.minX;
    const d = r.maxZ - r.minZ;
    const geo = new THREE.PlaneGeometry(w, d);
    geo.rotateX(-Math.PI / 2);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * d);
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
    m.position.set((r.minX + r.maxX) / 2, y, (r.minZ + r.maxZ) / 2);
    group.add(m);
  };
  const paving = grid('#55585c', '#2c2e31', 1.5);
  const asphalt = grid('#1d1f22', '#26282c', 3);
  plane(rect(-4.5, 4.5, -140, 8), asphalt, 0);
  plane(rect(4.5, 8.5, -140, 8), paving, 0.002);
  plane(rect(-8.5, -4.5, -140, 8), paving, 0.002);
  // metal grate (footstep surface test)
  const grate = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2).rotateX(-Math.PI / 2), lit(0x6d7680, 0.5));
  grate.position.set(6, 0.004, -4);
  group.add(grate);

  // building fronts
  box(rect(8.5, 12, -140, 8), 7, 0x3b3f47);
  box(rect(-12, -8.5, -140, 8), 7, 0x343841);
  // parked cars along both curbs
  box(ROUTE_CAR, 1.45, 0x6a3030);
  for (const z of [-13, -24, -60, -92]) box(rect(2.5, 2.5 + CAR.width, z, z - CAR.length), 1.45, 0x4c5560);
  for (const z of [-10, -30, -70]) box(rect(-2.5 - CAR.width, -2.5, z, z - CAR.length), 1.45, 0x2f455a);
  // hydrant, trash can, lamp pole
  box(rect(4.77, 5.13, -19.82, -20.18), 0.8, 0xaa3322);
  box(rect(7.8, 8.4, -11.7, -12.3), 1.0, 0x2c2f33);
  box(rect(4.85, 5.05, -7.9, -8.1), 7.6, 0x555a60);
  // scaffolding shed: a row of posts along each edge of the right sidewalk
  for (let z = -34; z >= -52; z -= 3) {
    box(rect(8.15, 8.29, z + 0.07, z - 0.07), 3, 0x8a8f96);
    box(rect(4.88, 5.02, z + 0.07, z - 0.07), 3, 0x8a8f96);
  }
  box(rect(4.8, 8.5, -33.6, -52.4), 0.12, 0x4a4033, false, 3);

  // light: enough to read shapes, still night
  group.add(new THREE.HemisphereLight(0x8fa3c8, 0x2a2622, 1.5));
  const key = new THREE.DirectionalLight(0xffd9b0, 1.6);
  key.position.set(-6, 12, 8);
  group.add(key);
  for (const z of [-8, -45, -80]) {
    const lamp = new THREE.PointLight(0xffa552, 60, 22, 1.8);
    lamp.position.set(5, 6, z);
    group.add(lamp);
  }
  return { colliders, group };
}

function surfaceAt(x: number, z: number): 'concrete' | 'asphalt' | 'metal' | 'tile' {
  if (x > 5.2 && x < 6.8 && z < -3 && z > -5) return 'metal';
  if (Math.abs(x) < 4.5) return 'asphalt';
  return 'concrete';
}

/* -------------------------------------------------------------- stub human */

/** A capsule with a nose. Satisfies Human; lives only in this harness. */
function createStubHuman(color: number): Human {
  const root = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const bodyMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 1.0, 4, 12), mat);
  bodyMesh.position.y = 0.76;
  root.add(bodyMesh);
  const head = new THREE.Group();
  head.position.y = 1.62;
  root.add(head);
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), mat));
  // The nose points along the model's forward axis: +Z when the controller's
  // yaw offset is PI (model built facing +Z), -Z when it is 0.
  const fwd = Math.cos(NPC_MODEL_YAW_OFFSET) < 0 ? 1 : -1;
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.14), new THREE.MeshStandardMaterial({ color: 0xffcc66, emissive: 0x553300 }));
  nose.position.z = fwd * 0.17;
  head.add(nose);
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.08), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
  chest.position.set(0, 1.2, fwd * 0.24);
  root.add(chest);

  let speed = 0;
  let cycle = 0;
  let gaze: THREE.Vector3 | null = null;
  const tmp = new THREE.Vector3();
  return {
    root,
    getHeadPosition(out = new THREE.Vector3()) {
      return out.set(root.position.x, 1.62, root.position.z);
    },
    setEmotion() {},
    setGaze(target) {
      gaze = target ? target.clone() : null;
    },
    setTalking() {},
    playGesture() {},
    setPosture() {},
    setLocomotion(s) {
      speed = s;
    },
    setVisible(v) {
      root.visible = v;
    },
    update(dt) {
      cycle += dt * speed * 4.4;
      bodyMesh.position.y = 0.76 + Math.abs(Math.sin(cycle)) * 0.02 * Math.min(1, speed);
      if (gaze) {
        tmp.copy(gaze);
        root.worldToLocal(tmp);
        const y = clamp(Math.atan2(tmp.x * fwd, tmp.z * fwd), -1.2, 1.2);
        head.rotation.y = y;
      } else {
        head.rotation.y = 0;
      }
    },
    dispose() {
      root.removeFromParent();
    },
  };
}

/** The real character model, when asked for with ?human=real and the module exists. */
async function loadRealHuman(): Promise<((opts: HumanOptions) => Human) | null> {
  if (qs.get('human') !== 'real') return null;
  const mods = import.meta.glob('../src/characters/human.ts');
  const load = mods['../src/characters/human.ts'];
  if (!load) return null;
  try {
    return ((await load()) as { createHuman: (opts: HumanOptions) => Human }).createHuman;
  } catch (err) {
    console.warn('[harness] src/characters/human.ts failed to load, using the stub', err);
    return null;
  }
}

/* -------------------------------------------------------------------- main */

interface LogEvent {
  t: number;
  type: string;
  [k: string]: unknown;
}

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
  const { engine, kind: engineKind } = await makeEngine(canvas);
  const street = buildStreet(engine.scene);
  const world = { colliders: street.colliders, bounds: BOUNDS, surfaceAt };

  const events: LogEvent[] = [];
  let simTime = 0;
  const log = (type: string, data: Record<string, unknown> = {}) => {
    events.push({ t: +simTime.toFixed(4), type, ...data });
    if (events.length > 4000) events.splice(0, 1000);
  };

  // count engine.pulse() calls without changing what they do
  const realPulse = engine.pulse.bind(engine);
  engine.pulse = (s: number) => {
    log('pulse', { strength: +s.toFixed(3) });
    realPulse(s);
  };

  const player = createPlayer(engine, world, { body: BODY, requireLock: !NOLOCK }) as PlayerController;
  player.on('step', (s) => log('step', { surface: s.surface, speed: +s.speed.toFixed(3), x: +s.position.x.toFixed(3), z: +s.position.z.toFixed(3) }));
  player.on('bumped', (b) => log('bumped', { who: b.collider === npcA ? 'a' : b.collider === npcB ? 'b' : '?' }));
  player.on('lock', () => log('lock'));
  player.on('unlock', () => log('unlock'));

  const realHuman = await loadRealHuman();
  const humanA = realHuman
    ? realHuman({ build: 'man', height: 1.86, hairStyle: 'buzz', topStyle: 'hoodie', top: 0x2b2f38, bottom: 0x1d2330, shoes: 0x101010 })
    : createStubHuman(0x7a4a3a);
  const humanB = realHuman ? realHuman({ build: 'woman', height: 1.68, hairStyle: 'ponytail', topStyle: 'coat', top: 0x8a6e52, accessory: 'tote' }) : createStubHuman(0x3a5a7a);
  const npcA: NpcController = createNpc(humanA, engine.scene);
  const npcB: NpcController = createNpc(humanB, engine.scene);
  const npcs = { a: npcA, b: npcB };
  const playerBody = { getPosition: () => player.position, radius: 0.34 };
  for (const [name, npc] of Object.entries(npcs)) {
    npc.setObstacles(world.colliders, world.bounds);
    npc.addAvoid(playerBody);
    npc.onStep((pos, speed) => log('npcStep', { who: name, speed: +speed.toFixed(3), x: +pos.x.toFixed(3), z: +pos.z.toFixed(3) }));
    player.addCollider(npc);
  }
  npcA.addAvoid(npcB);
  npcB.addAvoid(npcA);

  const v3 = (x: number, z: number, y = 0) => new THREE.Vector3(x, y, z);
  const playerPos = () => player.position;
  const playerFwd = () => player.getForward(new THREE.Vector3());

  /* ------------------------------------------------------------ behaviours */

  type BehaviourName = NpcBehaviour['type'];
  interface BehaviourParams {
    gap?: number;
    side?: 'left' | 'right';
    speed?: number;
    tx?: number;
    tz?: number;
  }
  const arrivedFlags: Record<string, boolean> = { a: false, b: false };

  function setBehaviour(which: 'a' | 'b', name: BehaviourName, pr: BehaviourParams = {}): void {
    const npc = npcs[which];
    const fwd = playerFwd();
    const ahead = v3(player.position.x + fwd.x * 12, player.position.z + fwd.z * 12);
    const target = pr.tx !== undefined && pr.tz !== undefined ? v3(pr.tx, pr.tz) : null;
    let b: NpcBehaviour;
    switch (name) {
      case 'goTo':
        b = { type: 'goTo', target: target ?? ahead, speed: pr.speed, faceOnArrive: playerPos };
        break;
      case 'path': {
        // a loop that crosses the street between the parked cars and back through the scaffolding
        const pts = [v3(6.5, -3), v3(-6.5, -6), v3(-6.5, -45), v3(6.6, -52), v3(6.6, -33)];
        b = { type: 'path', points: pts, speed: pr.speed, loop: true };
        break;
      }
      case 'walkAlongside':
        b = { type: 'walkAlongside', target: playerPos, targetForward: playerFwd, side: pr.side ?? 'left', gap: pr.gap ?? 1.0 };
        break;
      case 'followBehind':
        b = { type: 'followBehind', target: playerPos, gap: pr.gap ?? 2.2, speed: pr.speed };
        break;
      case 'block':
        b = { type: 'block', target: playerPos, targetForward: playerFwd, gap: pr.gap ?? 1.0 };
        break;
      case 'closeIn':
        b = { type: 'closeIn', target: playerPos, gap: pr.gap ?? 0.8, speed: pr.speed };
        break;
      case 'backAway':
        b = { type: 'backAway', from: playerPos, distance: pr.gap ?? 3, speed: pr.speed };
        break;
      case 'leave':
        b = { type: 'leave', to: target ?? v3(10.5, 6), speed: pr.speed };
        break;
      default:
        b = { type: 'idle', face: playerPos };
    }
    npc.human.setVisible(true);
    npc.setBehaviour(b);
    arrivedFlags[which] = false;
    const token = b;
    void npc.arrived().then(() => {
      arrivedFlags[which] = true;
      log('arrived', { who: which, behaviour: token.type });
    });
    log('behaviour', { who: which, behaviour: name });
  }

  /* ------------------------------------------------------------------ tick */

  function tick(dt: number): void {
    simTime += dt;
    player.update(dt);
    for (const npc of [npcA, npcB]) {
      npc.update(dt);
      npc.human.setGaze(player.getEyePosition(new THREE.Vector3()));
      npc.human.update(dt);
    }
  }

  /* -------------------------------------------------------------- overlays */

  const panel = document.querySelector<HTMLDivElement>('#panel')!;
  const readout = document.querySelector<HTMLDivElement>('#readout')!;
  const map = document.querySelector<HTMLCanvasElement>('#map')!;
  if (qs.get('map') === '0') map.classList.add('hidden');
  if (qs.get('ui') === '0') {
    panel.classList.add('hidden');
    readout.classList.add('hidden');
    map.classList.add('hidden');
    document.querySelector('#cross')!.classList.add('hidden');
  }
  panel.textContent = [
    `movement harness  ·  engine: ${engineKind}  ·  humans: ${realHuman ? 'real' : 'stub'}  ·  body: ${BODY}${NOLOCK ? '  ·  nolock' : ''}${PAUSED ? '  ·  paused' : ''}`,
    NOLOCK ? 'WASD walk · Shift hurry · arrows / drag look' : 'click to lock · WASD / arrows walk · Shift hurry · mouse look',
    'NPC A   1 idle  2 goTo  3 path  4 alongside-L  5 alongside-R',
    '        6 follow  7 block  8 closeIn  9 backAway  0 leave  R reset',
    'react   H flinch  B stepBack  J startle  G glance  Z freeze',
    'state   N tension  P phone  V body  I input on/off  M map',
  ].join('\n');

  let tensionLevel = num('tension', 0);
  let phoneUp = flag('phone');
  let bodyVisible = true;

  function drawOverlays(): void {
    const rs = player.getReactionState();
    const d = npcA.distanceTo(player.position);
    readout.textContent = [
      `t ${simTime.toFixed(2)}  player (${player.position.x.toFixed(2)}, ${player.position.z.toFixed(2)})  yaw ${(player.yaw / DEG).toFixed(0)}  pitch ${(player.pitch / DEG).toFixed(0)}  speed ${player.speed.toFixed(2)}`,
      `A ${npcA.behaviour.padEnd(13)} (${npcA.position.x.toFixed(2)}, ${npcA.position.z.toFixed(2)})  speed ${npcA.speed.toFixed(2)}  dist ${d.toFixed(2)}${arrivedFlags.a ? '  arrived' : ''}`,
      `B ${npcB.behaviour.padEnd(13)} (${npcB.position.x.toFixed(2)}, ${npcB.position.z.toFixed(2)})  speed ${npcB.speed.toFixed(2)}`,
      `tension ${rs.tension.toFixed(2)} +${rs.arousal.toFixed(2)}  legs ${rs.legs.toFixed(2)}  guard ${rs.guard.toFixed(2)}  keys ${rs.keys.toFixed(2)}  phone ${rs.phone.toFixed(2)}  ${rs.atRest ? 'at rest' : 'reacting'}  input ${player.inputEnabled ? 'on' : 'OFF'}`,
    ].join('\n');
    if (!map.classList.contains('hidden')) drawMap();
  }

  function drawMap(): void {
    const g = map.getContext('2d')!;
    const W = map.width;
    const H = map.height;
    const scale = 22; // px per metre
    g.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cz = H * 0.6;
    const X = (x: number) => cx + (x - player.position.x) * scale;
    const Z = (z: number) => cz + (z - player.position.z) * scale;
    g.fillStyle = '#3b4250';
    for (const r of world.colliders) g.fillRect(X(r.minX), Z(r.minZ), (r.maxX - r.minX) * scale, (r.maxZ - r.minZ) * scale);
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 1;
    for (const x of [-4.5, 4.5]) {
      g.beginPath();
      g.moveTo(X(x), 0);
      g.lineTo(X(x), H);
      g.stroke();
    }
    const body = (x: number, z: number, r: number, yaw: number, color: string) => {
      g.fillStyle = color;
      g.beginPath();
      g.arc(X(x), Z(z), r * scale, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(X(x), Z(z));
      g.lineTo(X(x - Math.sin(yaw) * 0.6), Z(z - Math.cos(yaw) * 0.6));
      g.stroke();
    };
    for (const [npc, color] of [
      [npcA, '#c0664a'],
      [npcB, '#4a86c0'],
    ] as const) {
      if (npc.radius <= 0) continue;
      const dbg = npc.debug();
      if (dbg.goal) {
        g.strokeStyle = color;
        g.lineWidth = 1;
        g.setLineDash([4, 4]);
        g.beginPath();
        g.moveTo(X(npc.position.x), Z(npc.position.z));
        for (const w of dbg.waypoints) g.lineTo(X(w.x), Z(w.z));
        g.lineTo(X(dbg.goal.x), Z(dbg.goal.z));
        g.stroke();
        g.setLineDash([]);
        g.strokeRect(X(dbg.goal.x) - 3, Z(dbg.goal.z) - 3, 6, 6);
      }
      body(npc.position.x, npc.position.z, npc.radius, dbg.yaw, color);
    }
    body(player.position.x, player.position.z, PLAYER_TUNING.radius, player.yaw, '#e9e4da');
  }

  /* ----------------------------------------------------------------- keys */

  const A = () => npcA.position;
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.code) {
      case 'Digit1':
        return setBehaviour('a', 'idle');
      case 'Digit2':
        return setBehaviour('a', 'goTo');
      case 'Digit3':
        return setBehaviour('a', 'path');
      case 'Digit4':
        return setBehaviour('a', 'walkAlongside', { side: 'left' });
      case 'Digit5':
        return setBehaviour('a', 'walkAlongside', { side: 'right' });
      case 'Digit6':
        return setBehaviour('a', 'followBehind');
      case 'Digit7':
        return setBehaviour('a', 'block');
      case 'Digit8':
        return setBehaviour('a', 'closeIn');
      case 'Digit9':
        return setBehaviour('a', 'backAway');
      case 'Digit0':
        return setBehaviour('a', 'leave');
      case 'KeyR': {
        const f = playerFwd();
        npcA.human.setVisible(true);
        npcA.setPose(v3(player.position.x + f.x * 3, player.position.z + f.z * 3), player.yaw + Math.PI);
        return setBehaviour('a', 'idle');
      }
      case 'KeyH':
        return player.flinch(A(), 0.8);
      case 'KeyB':
        return player.stepBack(A());
      case 'KeyJ':
        return player.startle(0.8);
      case 'KeyG':
        return player.glanceAt(npcA.human.getHeadPosition(), 1.2, 0.65);
      case 'KeyZ':
        return player.freeze(2);
      case 'KeyN':
        tensionLevel = tensionLevel >= 0.99 ? 0 : tensionLevel >= 0.49 ? 1 : 0.5;
        return player.setTension(tensionLevel);
      case 'KeyP':
        phoneUp = !phoneUp;
        return player.setPhoneRaised(phoneUp);
      case 'KeyV':
        bodyVisible = !bodyVisible;
        return player.setBodyVisible(bodyVisible);
      case 'KeyI':
        player.inputEnabled = !player.inputEnabled;
        return;
      case 'KeyM':
        map.classList.toggle('hidden');
        return;
    }
  });
  canvas.addEventListener('click', () => player.requestLock());

  /* ------------------------------------------------------- initial set-up */

  function applyScenario(name: string | null): void {
    switch (name) {
      case 'alongside':
        player.setPose(v3(6.5, 0), 0);
        npcA.setPose(v3(5.3, 1.2), 0);
        setBehaviour('a', 'walkAlongside', { side: 'left', gap: 1.0 });
        break;
      case 'follow':
        player.setPose(v3(6.5, 0), 0);
        npcA.setPose(v3(6.5, 5), 0);
        setBehaviour('a', 'followBehind', { gap: 2.2, speed: 2.4 });
        break;
      case 'block':
        player.setPose(v3(6.5, -14), 0);
        npcA.setPose(v3(6.5, -19), Math.PI);
        setBehaviour('a', 'block', { gap: 1.0 });
        break;
      case 'route':
        player.setPose(v3(7.5, -2), 30 * DEG);
        npcA.setPose(v3(6.5, -8.3), 0);
        setBehaviour('a', 'goTo', { tx: -6.5, tz: -12.3 });
        break;
      case 'posts':
        player.setPose(v3(6.8, -30), 0);
        npcA.setPose(v3(4.95, -32.5), 0);
        setBehaviour('a', 'goTo', { tx: 4.95, tz: -53.5 });
        break;
      case 'closein':
        player.setPose(v3(6.5, -14), 0);
        npcA.setPose(v3(6.5, -22), Math.PI);
        setBehaviour('a', 'closeIn', { gap: 0.8 });
        break;
      case 'squeeze':
        // he stands close to the wall: there is no room on the building side
        player.setPose(v3(8.1, -64), 0);
        npcA.setPose(v3(7.85, -68), Math.PI);
        setBehaviour('a', 'idle');
        break;
      default:
        player.setPose(v3(6.5, 0), 0);
        npcA.setPose(v3(6.2, -6), Math.PI);
        setBehaviour('a', 'idle');
    }
  }

  npcB.setPose(v3(-6.5, -6), 0);
  setBehaviour('b', 'path');
  applyScenario(qs.get('scenario'));
  if (qs.has('px') || qs.has('pz') || qs.has('pyaw')) player.setPose(v3(num('px', player.position.x), num('pz', player.position.z)), num('pyaw', player.yaw / DEG) * DEG);
  if (qs.has('ppitch')) player.setLook(player.yaw, num('ppitch', 0) * DEG);
  for (const which of ['a', 'b'] as const) {
    const npc = npcs[which];
    if (qs.has(`${which}x`) || qs.has(`${which}z`) || qs.has(`${which}yaw`)) {
      npc.setPose(v3(num(`${which}x`, npc.position.x), num(`${which}z`, npc.position.z)), num(`${which}yaw`, 0) * DEG);
    }
    const name = qs.get(which);
    if (name) {
      const side = qs.get('side') === 'right' ? 'right' : 'left';
      setBehaviour(which, name as BehaviourName, {
        gap: qs.has('gap') ? num('gap', 1) : undefined,
        side,
        speed: qs.has('speed') ? num('speed', 1.4) : undefined,
        tx: qs.has('tx') ? num('tx', 0) : undefined,
        tz: qs.has('tz') ? num('tz', 0) : undefined,
      });
    }
  }
  player.setTension(tensionLevel);
  player.setPhoneRaised(phoneUp);
  if (NOLOCK) player.requestLock();

  engine.onUpdate((dt) => {
    if (!PAUSED) tick(dt);
    drawOverlays();
  });
  engine.start();

  /* ------------------------------------------------------- window.__sim */

  const held = new Set<string>();
  const keyEvent = (type: 'keydown' | 'keyup', code: string) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
  function keys(...codes: string[]): void {
    for (const c of [...held]) {
      if (!codes.includes(c)) {
        keyEvent('keyup', c);
        held.delete(c);
      }
    }
    for (const c of codes) {
      if (!held.has(c)) {
        keyEvent('keydown', c);
        held.add(c);
      }
    }
  }

  const STEP = 1 / 60;
  /** Advance the simulation without rendering. `each` runs after every fixed step. */
  function step(seconds: number, each?: (t: number) => void): void {
    const n = Math.max(1, Math.round(seconds / STEP));
    for (let i = 0; i < n; i++) {
      tick(STEP);
      if (each) each(simTime);
    }
  }
  /** Like step(), but lets promise callbacks (arrived()) run every tenth of a second. */
  async function stepAsync(seconds: number, each?: (t: number) => void): Promise<void> {
    let left = seconds;
    while (left > 1e-9) {
      const chunk = Math.min(0.1, left);
      step(chunk, each);
      left -= chunk;
      await Promise.resolve();
    }
  }

  function render(): void {
    drawOverlays();
    if (engine.renderOnce) engine.renderOnce(0);
    else engine.renderer.render(engine.scene, engine.camera);
  }

  const r3 = (n: number) => +n.toFixed(3);
  const cam = () => {
    const c = engine.camera;
    return { x: r3(c.position.x), y: +c.position.y.toFixed(4), z: r3(c.position.z), yaw: r3(c.rotation.y / DEG), pitch: r3(c.rotation.x / DEG), roll: r3(c.rotation.z / DEG), fov: r3(c.fov) };
  };
  const npcState = (n: NpcController) => ({
    x: r3(n.position.x),
    z: r3(n.position.z),
    yaw: r3(n.yaw / DEG),
    speed: r3(n.speed),
    behaviour: n.behaviour,
    radius: n.radius,
    dist: r3(n.distanceTo(player.position)),
  });
  function state() {
    return {
      t: r3(simTime),
      player: { x: r3(player.position.x), z: r3(player.position.z), yaw: r3(player.yaw / DEG), pitch: r3(player.pitch / DEG), speed: r3(player.speed), locked: player.isLocked, input: player.inputEnabled },
      cam: cam(),
      reaction: player.getReactionState(),
      a: { ...npcState(npcA), arrived: arrivedFlags.a },
      b: { ...npcState(npcB), arrived: arrivedFlags.b },
    };
  }

  /* --------------------------------------------------------------- checks */

  /** Deepest a circle sits inside any static collider or beyond the bounds. */
  function staticPenetration(x: number, z: number, r: number): number {
    let worst = 0;
    for (const c of world.colliders) {
      const qx = clamp(x, c.minX, c.maxX);
      const qz = clamp(z, c.minZ, c.maxZ);
      const d = Math.hypot(x - qx, z - qz);
      const inside = x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ;
      worst = Math.max(worst, inside ? r + Math.min(x - c.minX, c.maxX - x, z - c.minZ, c.maxZ - z) : r - d);
    }
    worst = Math.max(worst, BOUNDS.minX + r - x, x - (BOUNDS.maxX - r), BOUNDS.minZ + r - z, z - (BOUNDS.maxZ - r));
    return Math.max(0, worst);
  }

  const PR = PLAYER_TUNING.radius;
  const park = () => {
    // both NPCs out of the way, idle, visible
    npcA.human.setVisible(true);
    npcB.human.setVisible(true);
    npcA.setPose(v3(-10.5, 6.5), 0);
    npcB.setPose(v3(-10.5, 5.2), 0);
    npcA.setBehaviour({ type: 'idle' });
    npcB.setBehaviour({ type: 'idle' });
  };
  /** Clean slate: keys up, input on, calm, reactions decayed. */
  function reset(px = 6.5, pz = -100, yawDeg = 0): void {
    keys();
    player.inputEnabled = true;
    player.setTension(0);
    player.setPhoneRaised(false);
    player.setBodyVisible(true);
    park();
    player.setPose(v3(px, pz), yawDeg * DEG);
    step(12); // let every reaction layer and the transient tension die away
    player.setPose(v3(px, pz), yawDeg * DEG);
    step(0.1);
  }
  const needNoLock = () => {
    if (!NOLOCK) throw new Error('checks drive the keyboard: open the harness with ?nolock=1&paused=1');
  };

  const checks = {
    /** The player cannot walk into buildings, cars, posts or out of the bounds. */
    async obstacles() {
      needNoLock();
      const cases: Array<{ name: string; x: number; z: number; yaw: number; keys: string[]; secs: number }> = [
        { name: 'building front (walk +X)', x: 6.5, z: -2, yaw: -90, keys: ['KeyW'], secs: 5 },
        { name: 'parked car from the sidewalk (walk -X)', x: 6.5, z: -8.3, yaw: 90, keys: ['KeyW'], secs: 5 },
        { name: 'car corner, diagonal + hurry', x: 6.2, z: -3.6, yaw: 50, keys: ['KeyW', 'ShiftLeft'], secs: 5 },
        { name: 'scaffold post head-on', x: 4.95, z: -32, yaw: 0, keys: ['KeyW'], secs: 5 },
        { name: 'hydrant, strafing', x: 6.5, z: -20, yaw: 0, keys: ['KeyA'], secs: 5 },
        { name: 'end of the block (walk +Z)', x: 0, z: 5, yaw: 180, keys: ['KeyW', 'ShiftLeft'], secs: 5 },
        { name: 'backwards into the trash can', x: 8.1, z: -14, yaw: 180, keys: ['KeyS'], secs: 5 },
      ];
      const out: Array<Record<string, unknown>> = [];
      for (const c of cases) {
        reset(c.x, c.z, c.yaw);
        let worst = 0;
        keys(...c.keys);
        step(c.secs, () => {
          worst = Math.max(worst, staticPenetration(player.position.x, player.position.z, PR));
        });
        keys();
        out.push({ case: c.name, maxPenetration: +worst.toFixed(5), end: [r3(player.position.x), r3(player.position.z)], moved: r3(Math.hypot(player.position.x - c.x, player.position.z - c.z)) });
      }
      // fuzz: three minutes of random walking and turning through the scaffolding and the cars,
      // with one NPC blocking and one following
      reset(6.5, -30, 0);
      npcA.setPose(v3(6.5, -36), 180 * DEG);
      setBehaviour('a', 'block');
      npcB.setPose(v3(6.5, -26), 0);
      setBehaviour('b', 'followBehind', { gap: 1.5 });
      let seed = 12345;
      const rnd = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      let worstStatic = 0;
      let worstNpcStatic = 0;
      let minNpc = Infinity;
      let nextChange = 0;
      const minTouch = PR + npcA.radius;
      step(180, (t) => {
        if (t >= nextChange) {
          nextChange = t + 0.3 + rnd() * 1.2;
          const ks: string[] = [];
          const f = rnd();
          if (f < 0.6) ks.push('KeyW');
          else if (f < 0.75) ks.push('KeyS');
          const s = rnd();
          if (s < 0.3) ks.push('KeyA');
          else if (s < 0.6) ks.push('KeyD');
          if (rnd() < 0.4) ks.push('ShiftLeft');
          keys(...ks);
          if (rnd() < 0.7) player.setLook(player.yaw + (rnd() - 0.5) * 2.4, 0);
          if (rnd() < 0.1) player.flinch(npcA.position, rnd());
          if (rnd() < 0.05) player.stepBack(npcA.position, 0.3 + rnd() * 0.6);
        }
        worstStatic = Math.max(worstStatic, staticPenetration(player.position.x, player.position.z, PR));
        for (const n of [npcA, npcB]) {
          worstNpcStatic = Math.max(worstNpcStatic, staticPenetration(n.position.x, n.position.z, 0.32));
          minNpc = Math.min(minNpc, n.distanceTo(player.position));
        }
      });
      keys();
      const fuzz = {
        seconds: 180,
        playerMaxPenetration: +worstStatic.toFixed(5),
        npcMaxPenetration: +worstNpcStatic.toFixed(5),
        minPlayerNpcDistance: r3(minNpc),
        touchingDistance: r3(minTouch),
      };
      const pass = out.every((o) => (o.maxPenetration as number) < 0.002) && worstStatic < 0.002 && worstNpcStatic < 0.002 && minNpc > minTouch - 0.01;
      return { pass, cases: out, fuzz };
    },

    /** The player cannot walk through an NPC; she slides round him only where there is room. */
    async npcSolid() {
      needNoLock();
      const touch = PR + 0.32;
      const run = (label: string, px: number, npcX: number, secs: number, mode: 'idle' | 'block', keyset: string[]) => {
        reset(px, -100, 0);
        npcA.setPose(v3(npcX, -105), 180 * DEG);
        if (mode === 'block') setBehaviour('a', 'block', { gap: 1.0 });
        else npcA.setBehaviour({ type: 'idle', face: playerPos });
        const before = events.length;
        let minD = Infinity;
        keys(...keyset);
        step(secs, () => {
          minD = Math.min(minD, npcA.distanceTo(player.position));
        });
        keys();
        const bumps = events.slice(before).filter((e) => e.type === 'bumped').length;
        return { case: label, minDistance: +minD.toFixed(4), touchingDistance: touch, playerEnd: [r3(player.position.x), r3(player.position.z)], npcEnd: [r3(npcA.position.x), r3(npcA.position.z)], passedHim: player.position.z < npcA.position.z - 0.3, bumps };
      };
      const results = [
        run('idle NPC, dead centre, W 8 s', 6.5, 6.5, 8, 'idle', ['KeyW']),
        run('idle NPC, 0.2 m off centre, W 8 s (room to slide round)', 6.7, 6.5, 8, 'idle', ['KeyW']),
        run('idle NPC, hurrying dead centre', 6.5, 6.5, 6, 'idle', ['KeyW', 'ShiftLeft']),
        run('NPC 0.33 m from the wall, player on the wall side: no room', 8.1, 7.85, 8, 'idle', ['KeyW']),
        run('blocking NPC, W 8 s', 6.5, 6.5, 8, 'block', ['KeyW']),
        run('blocking NPC, W + D 8 s', 6.5, 6.5, 8, 'block', ['KeyW', 'KeyD']),
      ];
      const pass =
        results.every((r) => r.minDistance > touch - 0.006) &&
        !results[0].passedHim &&
        results[1].passedHim &&
        !results[3].passedHim &&
        !results[4].passedHim &&
        results[0].bumps > 0;
      return { pass, results };
    },

    /** walkAlongside holds the lateral gap while she walks, and stops and turns to her when she stops. */
    async alongside() {
      needNoLock();
      const run = (side: 'left' | 'right', gap: number, keyset: string[]) => {
        reset(6.5, 0, 0);
        npcA.setPose(v3(side === 'left' ? 5.4 : 7.6, 1.5), 0);
        setBehaviour('a', 'walkAlongside', { side, gap });
        const lat: number[] = [];
        const ahead: number[] = [];
        const turn: number[] = [];
        const t0 = simTime;
        let speedSum = 0;
        let n = 0;
        keys(...keyset);
        step(20, (t) => {
          if (t - t0 < 4) return;
          // she walks toward -Z: right is +X, ahead is -Z
          lat.push(Math.abs(npcA.position.x - player.position.x));
          ahead.push(-(npcA.position.z - player.position.z));
          turn.push(wrapAngle(npcA.yaw - 0) / DEG);
          speedSum += npcA.speed;
          n++;
        });
        const playerSpeed = player.speed;
        keys();
        step(3);
        const facingErr = Math.abs(wrapAngle(yawOf(player.position.x - npcA.position.x, player.position.z - npcA.position.z) - npcA.yaw)) / DEG;
        const sorted = (a: number[]) => [...a].sort((p, q) => p - q);
        const L = sorted(lat);
        const Ah = sorted(ahead);
        const Tn = sorted(turn);
        return {
          side,
          gap,
          keys: keyset.join('+'),
          playerSpeed: r3(playerSpeed),
          lateralGap: { min: r3(L[0]), max: r3(L[L.length - 1]), mean: r3(L.reduce((s, v) => s + v, 0) / L.length) },
          ahead: { min: r3(Ah[0]), max: r3(Ah[Ah.length - 1]) },
          bodyTurnDeg: { min: r3(Tn[0]), max: r3(Tn[Tn.length - 1]) },
          npcMeanSpeed: r3(speedSum / n),
          afterSheStops: { npcSpeed: r3(npcA.speed), facingErrorDeg: r3(facingErr), distance: r3(npcA.distanceTo(player.position)) },
        };
      };
      const results = [run('left', 1.0, ['KeyW']), run('right', 1.0, ['KeyW']), run('left', 0.9, ['KeyW', 'ShiftLeft'])];
      const pass = results.every((r) => Math.abs(r.lateralGap.min - r.gap) <= 0.3 && Math.abs(r.lateralGap.max - r.gap) <= 0.3 && r.afterSheStops.npcSpeed < 0.05 && r.afterSheStops.facingErrorDeg < 8);
      return { pass, results };
    },

    /** followBehind trails at the gap, stops when she stops, and never closes inside the gap. */
    async follow() {
      needNoLock();
      const gap = 2.2;
      reset(6.5, 0, 0);
      npcA.setPose(v3(6.5, 5), 0);
      setBehaviour('a', 'followBehind', { gap, speed: 2.4 });
      let minD = Infinity;
      const track = () => {
        minD = Math.min(minD, npcA.distanceTo(player.position));
      };
      const phases: Array<Record<string, unknown>> = [];
      const phase = (label: string, keyset: string[], secs: number) => {
        keys(...keyset);
        let sum = 0;
        let n = 0;
        const t0 = simTime;
        step(secs, (t) => {
          track();
          if (t - t0 > secs * 0.5) {
            sum += npcA.distanceTo(player.position);
            n++;
          }
        });
        phases.push({ phase: label, endDistance: r3(npcA.distanceTo(player.position)), meanDistanceSecondHalf: r3(sum / n), npcSpeedAtEnd: r3(npcA.speed), playerSpeedAtEnd: r3(player.speed) });
      };
      phase('walk 8 s', ['KeyW'], 8);
      phase('stop 4 s', [], 4);
      phase('hurry 6 s', ['KeyW', 'ShiftLeft'], 6);
      phase('stop 4 s', [], 4);
      phase('walk 3 s', ['KeyW'], 3);
      phase('stop 4 s', [], 4);
      const pass = minD >= gap - 0.02 && [1, 3, 5].every((i) => (phases[i].npcSpeedAtEnd as number) < 0.03 && Math.abs((phases[i].endDistance as number) - gap) < 0.25);
      return { pass, gap, minDistance: +minD.toFixed(4), phases };
    },

    /** block stays in her path as she side-steps at walking pace; a dead-ahead push gets nowhere. */
    async block() {
      needNoLock();
      const gap = 1.0;
      // in the roadway, clear of the cars: room to strafe several metres each way
      reset(0, -45, 0);
      npcA.setPose(v3(0, -51), 180 * DEG);
      setBehaviour('a', 'block', { gap });
      step(3);
      const settle = { lateral: r3(npcA.position.x - player.position.x), ahead: r3(-(npcA.position.z - player.position.z)) };
      const phases: Array<Record<string, unknown>> = [];
      let worstSteady = 0;
      let minAhead = Infinity;
      let minD = Infinity;
      const phase = (label: string, keyset: string[], secs: number) => {
        keys(...keyset);
        const t0 = simTime;
        let steady = 0;
        let all = 0;
        let strafeSpeed = 0;
        step(secs, (t) => {
          const lateral = Math.abs(npcA.position.x - player.position.x);
          const ahead = -(npcA.position.z - player.position.z);
          all = Math.max(all, lateral);
          minAhead = Math.min(minAhead, ahead);
          minD = Math.min(minD, npcA.distanceTo(player.position));
          // "steady" = he has had his reaction time plus a second to catch up after she changed direction
          if (t - t0 > 1.5) steady = Math.max(steady, lateral);
          strafeSpeed = player.speed;
        });
        worstSteady = Math.max(worstSteady, steady);
        phases.push({ phase: label, playerSpeed: r3(strafeSpeed), maxLateralOffset: r3(all), maxLateralOffsetAfter1500ms: r3(steady), playerX: r3(player.position.x), npcX: r3(npcA.position.x) });
      };
      phase('strafe right 3 s', ['KeyD'], 3);
      phase('strafe left 6 s', ['KeyA'], 6);
      phase('strafe right 3 s', ['KeyD'], 3);
      keys();
      step(1.5);
      // now walk straight at him
      const z0 = player.position.z;
      const az0 = npcA.position.z;
      const gapBefore = npcA.distanceTo(player.position);
      const before = events.length;
      keys('KeyW');
      step(5, () => {
        minD = Math.min(minD, npcA.distanceTo(player.position));
      });
      keys();
      const push = {
        distanceBefore: r3(gapBefore),
        advanced: r3(z0 - player.position.z),
        npcGaveGround: r3(az0 - npcA.position.z),
        stillAhead: npcA.position.z < player.position.z,
        bumps: events.slice(before).filter((e) => e.type === 'bumped').length,
      };
      // determined attempts to get round him
      const tries: Array<Record<string, unknown>> = [];
      const attempt = (label: string, seq: Array<[string[], number, number?]>) => {
        reset(0, -45, 0);
        npcA.setPose(v3(0, -46), 180 * DEG);
        setBehaviour('a', 'block', { gap });
        step(2);
        let dmin = Infinity;
        let clearFor = 0; // seconds during which he was not in her way
        const start = player.position.clone();
        for (const [ks, secs, turnDeg] of seq) {
          if (turnDeg) player.setLook(player.yaw + turnDeg * DEG, 0);
          keys(...ks);
          step(secs, () => {
            dmin = Math.min(dmin, npcA.distanceTo(player.position));
            const f = playerFwd();
            const rx = npcA.position.x - player.position.x;
            const rz = npcA.position.z - player.position.z;
            const ahead = rx * f.x + rz * f.z;
            const lateral = Math.abs(-f.z * rx + f.x * rz);
            if (!(ahead > 0 && lateral < touch)) clearFor += STEP;
          });
        }
        keys();
        const f = playerFwd();
        const rx = npcA.position.x - player.position.x;
        const rz = npcA.position.z - player.position.z;
        const ahead = rx * f.x + rz * f.z;
        const lateral = Math.abs(-f.z * rx + f.x * rz);
        tries.push({
          attempt: label,
          gotPast: !(ahead > 0 && lateral < touch),
          secondsWithAClearPath: r3(clearFor),
          travelled: r3(player.position.distanceTo(start)),
          npcAheadOfHer: r3(ahead),
          npcLateral: r3(lateral),
          minDistance: r3(dmin),
        });
        minD = Math.min(minD, dmin);
      };
      const touch = PR + 0.32;
      attempt('walk diagonally right (W+D) 4 s', [[['KeyW', 'KeyD'], 4]]);
      attempt('hurry diagonally right (Shift+W+D) 4 s', [[['KeyW', 'KeyD', 'ShiftLeft'], 4]]);
      attempt('feint right 0.6 s, then hurry left-forward 3 s', [
        [['KeyD'], 0.6],
        [['KeyW', 'KeyA', 'ShiftLeft'], 3],
      ]);
      attempt('strafe right 1.2 s, then hurry straight 3 s', [
        [['KeyD'], 1.2],
        [['KeyW', 'ShiftLeft'], 3],
      ]);
      attempt('turn 50 deg right and walk 3 s', [[['KeyW'], 3, -50]]);
      attempt('turn 50 deg right and hurry 3 s', [[['KeyW', 'ShiftLeft'], 3, -50]]);
      attempt('turn 90 deg left and hurry 3 s', [[['KeyW', 'ShiftLeft'], 3, 90]]);
      attempt('zig-zag: hurry 40 deg right 0.7 s, 80 deg left 0.7 s, x3', [
        [['KeyW', 'ShiftLeft'], 0.7, -40],
        [['KeyW', 'ShiftLeft'], 0.7, 80],
        [['KeyW', 'ShiftLeft'], 0.7, -80],
        [['KeyW', 'ShiftLeft'], 0.7, 80],
        [['KeyW', 'ShiftLeft'], 0.7, -80],
        [['KeyW', 'ShiftLeft'], 0.7, 80],
      ]);
      const pass = worstSteady < 0.3 && minAhead > 0.3 && push.advanced < gapBefore - touch + 0.05 && push.npcGaveGround < 0.05 && push.stillAhead && minD > touch - 0.006;
      return { pass, gap, settle, phases, worstSteadyLateralOffset: r3(worstSteady), minAheadDuringStrafes: r3(minAhead), pushStraightAtHim: push, determinedAttempts: tries, minDistance: +minD.toFixed(4) };
    },

    /** NPCs get round a parked car, through a row of scaffold posts, and give up cleanly on an impossible goal. */
    async route() {
      needNoLock();
      const run = async (label: string, from: [number, number], make: () => NpcBehaviour, to: [number, number], limit: number) => {
        reset(7.6, -100, 0);
        npcA.setPose(v3(from[0], from[1]), 0);
        let arrived = false;
        npcA.setBehaviour(make());
        void npcA.arrived().then(() => (arrived = true));
        let worst = 0;
        let pathLen = 0;
        let slowTime = 0;
        let arrivedAt = -1;
        let lx = from[0];
        let lz = from[1];
        const t0 = simTime;
        let t = 0;
        while (t < limit && !arrived) {
          await stepAsync(0.1, (now) => {
            worst = Math.max(worst, staticPenetration(npcA.position.x, npcA.position.z, 0.32));
            pathLen += Math.hypot(npcA.position.x - lx, npcA.position.z - lz);
            lx = npcA.position.x;
            lz = npcA.position.z;
            if (now - t0 > 1 && npcA.speed < 0.4) slowTime += STEP;
          });
          t = simTime - t0;
          if (arrived && arrivedAt < 0) arrivedAt = t;
        }
        const straight = Math.hypot(to[0] - from[0], to[1] - from[1]);
        return {
          case: label,
          arrived,
          seconds: r3(arrivedAt < 0 ? t : arrivedAt),
          straightLine: r3(straight),
          walked: r3(pathLen),
          secondsBelow04: r3(slowTime),
          endDistanceToGoal: r3(Math.hypot(npcA.position.x - to[0], npcA.position.z - to[1])),
          maxPenetration: +worst.toFixed(5),
          visibleAtEnd: npcA.human.root.visible,
        };
      };
      const carMid = (ROUTE_CAR.minZ + ROUTE_CAR.maxZ) / 2;
      const results = [
        await run('goTo straight across a parked car', [6.5, carMid], () => ({ type: 'goTo', target: v3(0, carMid) }), [0, carMid], 20),
        await run('goTo across the street, a car at each curb', [6.5, -8.3], () => ({ type: 'goTo', target: v3(-6.5, -12.3) }), [-6.5, -12.3], 30),
        await run('goTo down the line of scaffold posts', [4.95, -32.5], () => ({ type: 'goTo', target: v3(4.95, -53.5), speed: 2.0 }), [4.95, -53.5], 30),
        await run('goTo from behind a post to the far side of the next', [4.95, -33.4], () => ({ type: 'goTo', target: v3(4.95, -37.6) }), [4.95, -37.6], 15),
        await run('leave round the hydrant to the corner', [5.0, -22], () => ({ type: 'leave', to: v3(5.0, -1), speed: 1.5 }), [5.0, -1], 30),
        await run('goTo a point inside a car (unreachable): arrives beside it', [6.5, -15], () => ({ type: 'goTo', target: v3(3.4, -15.3) }), [3.4, -15.3], 20),
      ];
      park();
      const pass =
        results.every((r) => r.arrived && r.maxPenetration < 0.002) &&
        results.slice(0, 5).every((r) => r.endDistanceToGoal < 0.3 && r.secondsBelow04 < 1.5) &&
        results[4].visibleAtEnd === false;
      return { pass, results };
    },

    /** closeIn stops at the gap, backAway covers its distance facing her, path loops, behaviour changes do not snap. */
    async approach() {
      needNoLock();
      reset(6.5, -100, 0);
      // closeIn
      npcA.setPose(v3(6.5, -108), 180 * DEG);
      let arrived = false;
      npcA.setBehaviour({ type: 'closeIn', target: playerPos, gap: 0.8, speed: 1.4 });
      void npcA.arrived().then(() => (arrived = true));
      let minD = Infinity;
      await stepAsync(10, () => {
        minD = Math.min(minD, npcA.distanceTo(player.position));
      });
      const closeIn = { arrived, endDistance: r3(npcA.distanceTo(player.position)), minDistance: r3(minD), npcSpeed: r3(npcA.speed), facingErrorDeg: r3(Math.abs(wrapAngle(yawOf(player.position.x - npcA.position.x, player.position.z - npcA.position.z) - npcA.yaw)) / DEG) };
      // backAway
      const start = npcA.position.clone();
      arrived = false;
      npcA.setBehaviour({ type: 'backAway', from: playerPos, distance: 3.2, speed: 1.1 });
      void npcA.arrived().then(() => (arrived = true));
      let maxFacingErr = 0;
      let t = 0;
      while (t < 10 && !arrived) {
        await stepAsync(0.1, () => {
          maxFacingErr = Math.max(maxFacingErr, Math.abs(wrapAngle(yawOf(player.position.x - npcA.position.x, player.position.z - npcA.position.z) - npcA.yaw)) / DEG);
        });
        t += 0.1;
      }
      step(1);
      const backAway = { arrived, seconds: r3(t), covered: r3(npcA.position.distanceTo(start)), behaviourAfter: npcA.behaviour, maxFacingErrorDeg: r3(maxFacingErr), npcSpeed: r3(npcA.speed) };
      // snapping: change behaviour every 0.7 s and watch the largest per-frame change in velocity and heading
      reset(6.5, -100, 0);
      npcA.setPose(v3(5.5, -103), 0);
      const seq: Array<() => void> = [
        () => setBehaviour('a', 'walkAlongside', { side: 'left' }),
        () => setBehaviour('a', 'block'),
        () => setBehaviour('a', 'goTo', { tx: -6, tz: -110, speed: 2 }),
        () => setBehaviour('a', 'followBehind', { gap: 2 }),
        () => setBehaviour('a', 'closeIn', { gap: 0.8, speed: 2.2 }),
        () => setBehaviour('a', 'backAway'),
        () => setBehaviour('a', 'goTo', { tx: 6, tz: -95, speed: 2 }),
        () => setBehaviour('a', 'idle'),
      ];
      let maxDv = 0;
      let maxDyaw = 0;
      let maxSpeed = 0;
      keys('KeyW');
      for (let i = 0; i < 24; i++) {
        seq[i % seq.length]();
        let pv = npcA.debug();
        step(0.7, () => {
          const d = npcA.debug();
          maxDv = Math.max(maxDv, Math.hypot(d.vx - pv.vx, d.vz - pv.vz));
          maxDyaw = Math.max(maxDyaw, Math.abs(wrapAngle(d.yaw - pv.yaw)));
          maxSpeed = Math.max(maxSpeed, Math.hypot(d.vx, d.vz));
          pv = d;
        });
        if (i % 6 === 5) player.setLook(player.yaw + 2.2, 0);
      }
      keys();
      const blend = {
        // includes being stopped dead by a body or a wall, which is not a behaviour snap
        maxAccel: r3(maxDv / STEP),
        maxTurnRateDeg: r3(maxDyaw / STEP / DEG),
        maxSpeed: r3(maxSpeed),
      };
      const pass =
        closeIn.arrived && closeIn.minDistance >= 0.8 - 0.01 && closeIn.endDistance < 0.95 && closeIn.facingErrorDeg < 5 &&
        backAway.arrived && Math.abs(backAway.covered - 3.2) < 0.2 && backAway.behaviourAfter === 'idle' && backAway.maxFacingErrorDeg < 25 &&
        blend.maxSpeed <= 2.95 && blend.maxTurnRateDeg <= 241;
      return { pass, closeIn, backAway, blend };
    },

    /** Walking: speeds, acceleration, stride / footfalls, surfaces, stuck keys. */
    async locomotion() {
      needNoLock();
      const measure = (label: string, keyset: string[], secs: number, yawDeg = 0) => {
        reset(6.5, -70, yawDeg);
        const before = events.length;
        const x0 = player.position.x;
        const z0 = player.position.z;
        const series: number[] = [];
        const t0 = simTime;
        keys(...keyset);
        let prev = 0;
        let maxJump = 0;
        step(secs, () => {
          const s = player.speed;
          maxJump = Math.max(maxJump, Math.abs(s - prev));
          prev = s;
          series.push(s);
        });
        const steady = player.speed;
        const t90 = (series.findIndex((s) => s >= 0.9 * steady) + 1) * STEP;
        const dist = Math.hypot(player.position.x - x0, player.position.z - z0);
        const steps = events.slice(before).filter((e) => e.type === 'step');
        keys();
        let stopTime = 0;
        step(1.5, (t) => {
          if (player.speed > 0.02) stopTime = t - (t0 + secs);
        });
        return { case: label, steadySpeed: r3(steady), distance: r3(dist), footfalls: steps.length, metresPerFootfall: steps.length ? r3(dist / steps.length) : null, stepsPerMinute: r3((steps.length / secs) * 60), maxSpeedChangePerFrame: r3(maxJump), secondsTo90pct: r3(t90), secondsToStop: r3(stopTime) };
      };
      const results = [
        measure('walk (W)', ['KeyW'], 10),
        measure('hurry (Shift+W)', ['KeyW', 'ShiftLeft'], 10),
        measure('backwards (S)', ['KeyS'], 6),
        measure('strafe (D), facing across the street', ['KeyD'], 4, 90),
        measure('diagonal (W+A)', ['KeyW', 'KeyA'], 3),
      ];
      // surfaces: walk off the kerb across the metal grate
      reset(6, -1.5, 0);
      const b0 = events.length;
      keys('KeyW');
      step(4);
      keys();
      const surfaces = [...new Set(events.slice(b0).filter((e) => e.type === 'step').map((e) => e.surface as string))];
      // keys must not stick when focus is lost
      reset(6.5, -70, 0);
      keys('KeyW');
      step(1);
      const movingBefore = player.speed;
      window.dispatchEvent(new Event('blur'));
      held.clear();
      step(1.5);
      const stuck = { speedBeforeBlur: r3(movingBefore), speedAfterBlur: r3(player.speed) };
      // inputEnabled = false stops walking and looking, but not reactions
      reset(6.5, -70, 0);
      player.inputEnabled = false;
      keys('KeyW');
      const zBefore = player.position.z;
      step(1);
      const yawBefore = player.yaw;
      canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, movementX: 200, movementY: 50 }));
      const lookIgnored = player.yaw === yawBefore;
      player.startle(1);
      let lift = 0;
      step(0.5, () => {
        lift = Math.max(lift, player.getReactionState().lift);
      });
      const disabled = { moved: r3(Math.abs(player.position.z - zBefore)), lookIgnored, startleLiftStillPlays: r3(lift) };
      player.inputEnabled = true;
      // with input back on, the same drag does turn the view
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, movementX: 200, movementY: 50 }));
      const dragLook = { yawChangeDeg: r3(wrapAngle(player.yaw - yawBefore) / DEG), pitchDeg: r3(player.pitch / DEG) };
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      keys();
      // pitch clamp
      player.setLook(0, -3);
      const pitchMin = player.pitch / DEG;
      player.setLook(0, 3);
      const pitchMax = player.pitch / DEG;
      player.setLook(0, 0);
      const pass =
        Math.abs(results[0].steadySpeed - 1.45) < 0.01 &&
        Math.abs(results[1].steadySpeed - 2.3) < 0.01 &&
        Math.abs(results[2].steadySpeed - 1.45 * 0.7) < 0.01 &&
        Math.abs(results[3].steadySpeed - 1.45 * 0.7) < 0.01 &&
        Math.abs((results[0].metresPerFootfall ?? 0) - 0.68) < 0.04 &&
        surfaces.includes('metal') && surfaces.includes('concrete') &&
        stuck.speedAfterBlur < 0.01 && disabled.moved < 0.01 && disabled.lookIgnored && disabled.startleLiftStillPlays > 0.03;
      return { pass, results, surfaces, stuck, disabled, dragLook, pitchClampDeg: [r3(pitchMin), r3(pitchMax)] };
    },

    /** Every reaction plays, composes, and returns the camera to rest. */
    async reactions() {
      needNoLock();
      const threatAhead = () => v3(player.position.x, player.position.z - 1.2);
      const threatRight = () => v3(player.position.x + 1.0, player.position.z - 0.2);
      const run = (label: string, fire: () => void, opts: { holdW?: boolean; secs?: number; setup?: () => void } = {}) => {
        reset(6.5, -70, 0);
        if (opts.setup) {
          opts.setup();
          step(0.1);
        }
        // rest pose is taken standing still, before any walking, and compared standing still at the end
        const rest = cam();
        if (opts.holdW) {
          keys('KeyW');
          step(1.5);
        }
        const p0 = player.position.clone();
        const before = events.length;
        const baseFov = engine.camera.fov;
        fire();
        const peak = { yawOff: 0, pitchOff: 0, roll: 0, liftUp: 0, liftDown: 0, fov: 0, guard: 0, glanceYaw: 0, minLegs: 1 };
        const yawSeries: number[] = [];
        let backAt200 = -1;
        let backMax = 0;
        let maxFrameRot = 0;
        let prev = cam();
        const t0 = simTime;
        let movedDuringFreeze = 0;
        let atRestAt = -1;
        const secs = opts.secs ?? 8;
        step(secs, (t) => {
          const rs = player.getReactionState();
          const c = cam();
          peak.yawOff = Math.abs(rs.yaw) > Math.abs(peak.yawOff) ? rs.yaw : peak.yawOff;
          peak.pitchOff = Math.abs(rs.pitch) > Math.abs(peak.pitchOff) ? rs.pitch : peak.pitchOff;
          peak.roll = Math.abs(rs.roll) > Math.abs(peak.roll) ? rs.roll : peak.roll;
          peak.liftUp = Math.max(peak.liftUp, rs.lift);
          peak.liftDown = Math.min(peak.liftDown, rs.lift);
          peak.fov = Math.max(peak.fov, c.fov - baseFov);
          peak.guard = Math.max(peak.guard, rs.guard);
          peak.glanceYaw = Math.abs(rs.glanceYaw) > Math.abs(peak.glanceYaw) ? rs.glanceYaw : peak.glanceYaw;
          peak.minLegs = Math.min(peak.minLegs, rs.legs);
          if (t - t0 < 0.6) yawSeries.push(+rs.yaw.toFixed(2));
          // displacement away from the start, along +Z (the threat is ahead at -Z)
          const back = player.position.z - p0.z;
          backMax = Math.max(backMax, Math.hypot(player.position.x - p0.x, player.position.z - p0.z));
          if (backAt200 < 0 && t - t0 >= 0.2) backAt200 = back;
          maxFrameRot = Math.max(maxFrameRot, Math.abs(wrapAngle((c.yaw - prev.yaw) * DEG)) / DEG, Math.abs(c.pitch - prev.pitch));
          prev = c;
          if (t - t0 <= 0.35) movedDuringFreeze = Math.hypot(player.position.x - p0.x, player.position.z - p0.z);
          if (atRestAt < 0 && rs.atRest) atRestAt = t - t0;
          if (atRestAt >= 0 && !rs.atRest) atRestAt = -1;
        });
        keys();
        if (opts.holdW) step(1.5);
        const end = cam();
        const rs = player.getReactionState();
        const steps = events.slice(before).filter((e) => e.type === 'step').length;
        const pulses = events.slice(before).filter((e) => e.type === 'pulse').map((e) => e.strength);
        return {
          reaction: label,
          peak: Object.fromEntries(Object.entries(peak).map(([k, v]) => [k, +v.toFixed(4)])),
          displacement: r3(Math.hypot(player.position.x - p0.x, player.position.z - p0.z)),
          displacedAt200ms: r3(backAt200),
          maxViewRotationPerFrameDeg: r3(maxFrameRot),
          footfalls: steps,
          pulses,
          movedIn350ms: r3(movedDuringFreeze),
          secondsToRest: r3(atRestAt),
          yawOffsetFirst600ms: yawSeries.filter((_, i) => i % 3 === 0),
          end: {
            atRest: rs.atRest,
            yawErrDeg: r3(wrapAngle((end.yaw - rest.yaw) * DEG) / DEG),
            pitchErrDeg: r3(end.pitch - rest.pitch),
            rollDeg: end.roll,
            eyeHeightErr: +(end.y - rest.y).toFixed(4),
            fovErr: r3(end.fov - rest.fov),
            arousal: r3(rs.arousal),
          },
        };
      };
      const results = [
        run('flinch(ahead, 0.3)', () => player.flinch(threatAhead(), 0.3)),
        run('flinch(ahead, 1.0)', () => player.flinch(threatAhead(), 1)),
        run('flinch(from her right, 1.0)', () => player.flinch(threatRight(), 1)),
        run('flinch(ahead, 1.0) with the end of the block 0.1 m behind her', () => player.flinch(threatAhead(), 1), { setup: () => player.setPose(v3(6.5, 7.6), 0) }),
        run('stepBack(ahead) default 0.6 m / 0.5 s', () => player.stepBack(threatAhead())),
        run('stepBack(ahead, 0.35, 0.4)', () => player.stepBack(threatAhead(), 0.35, 0.4)),
        run('startle(0.5)', () => player.startle(0.5)),
        run('startle(1.0) while walking (W held)', () => player.startle(1), { holdW: true, secs: 3 }),
        run('glanceAt(behind-left, 1.2 s, weight 0.65)', () => player.glanceAt(v3(player.position.x - 1.5, player.position.z + 3, 1.6), 1.2, 0.65)),
        run('glanceAt(weight 5 -> clamped)', () => player.glanceAt(v3(player.position.x + 3, player.position.z, 1.6), 1.0, 5)),
        run('freeze(1.5) while walking (W held)', () => player.freeze(1.5), { holdW: true, secs: 4 }),
        run('flinch + startle + glance together', () => {
          player.glanceAt(v3(player.position.x - 2, player.position.z + 2, 1.6), 1.0, 0.6);
          player.startle(1);
          player.flinch(threatAhead(), 1);
        }),
      ];
      // stepBack with W held: input is suppressed for its duration
      reset(6.5, -70, 0);
      keys('KeyW');
      step(1.5);
      const zW = player.position.z;
      const beforeSB = events.length;
      player.stepBack(v3(player.position.x, player.position.z - 1), 0.6, 0.5);
      let far = 0;
      step(0.55, () => {
        far = Math.max(far, player.position.z - zW);
      });
      const sbSteps = events.slice(beforeSB).filter((e) => e.type === 'step').length;
      step(1.5);
      keys();
      const stepBackWhileWalking = { movedBack: r3(far), footfallsDuring: sbSteps, walkingAgainAfter: player.position.z < zW };
      // tension: sway and tremor grow, keys hand comes up; phone raise (bystander only)
      const sway = (level: number) => {
        reset(6.5, -70, 0);
        player.setTension(level);
        step(6);
        let minY = Infinity;
        let maxY = -Infinity;
        let minP = Infinity;
        let maxP = -Infinity;
        let jitter = 0;
        let prevYaw = cam().yaw;
        step(8, () => {
          const c = cam();
          minY = Math.min(minY, c.y);
          maxY = Math.max(maxY, c.y);
          minP = Math.min(minP, c.pitch);
          maxP = Math.max(maxP, c.pitch);
          jitter = Math.max(jitter, Math.abs(c.yaw - prevYaw));
          prevYaw = c.yaw;
        });
        return { tension: level, eyeHeightSwingMm: r3((maxY - minY) * 1000), pitchSwingDeg: r3(maxP - minP), maxYawStepPerFrameDeg: r3(jitter), keysRaise: r3(player.getReactionState().keys) };
      };
      const tension = [sway(0), sway(0.5), sway(1)];
      reset(6.5, -70, 0);
      player.setPhoneRaised(true);
      step(1.5);
      const phoneUpLevel = player.getReactionState().phone;
      player.setPhoneRaised(false);
      step(1.5);
      const phoneInfo = { body: BODY, raised: r3(phoneUpLevel), lowered: r3(player.getReactionState().phone) };

      const flinchOK = [results[0], results[1], results[2]].every((r) => r.displacement >= 0.14 && r.displacement <= 0.36 && r.footfalls >= 1);
      const pass =
        results.every((r) => r.end.atRest && Math.abs(r.end.yawErrDeg) < 0.3 && Math.abs(r.end.pitchErrDeg) < 0.6 && Math.abs(r.end.eyeHeightErr) < 0.006 && Math.abs(r.end.fovErr) < 0.01) &&
        flinchOK &&
        results[3].displacement < 0.12 &&
        Math.abs(results[4].displacement - 0.6) < 0.02 && results[4].footfalls === 2 &&
        Math.abs(results[5].displacement - 0.35) < 0.02 && results[5].footfalls === 1 &&
        results[6].peak.liftUp >= 0.03 && results[7].peak.liftUp <= 0.065 && results[7].peak.fov >= 2 && results[7].peak.fov <= 4.05 && results[7].movedIn350ms < 0.12 &&
        Math.abs(results[9].peak.glanceYaw) <= 0.8 * 90 + 1 &&
        stepBackWhileWalking.movedBack > 0.4 && stepBackWhileWalking.walkingAgainAfter &&
        tension[2].eyeHeightSwingMm > tension[0].eyeHeightSwingMm * 2;
      return { pass, results, stepBackWhileWalking, tension, phone: phoneInfo };
    },
  };

  async function runChecks(names?: Array<keyof typeof checks>): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const name of names ?? (Object.keys(checks) as Array<keyof typeof checks>)) {
      const t0 = performance.now();
      try {
        const res = await checks[name]();
        out[name] = { ...res, ms: Math.round(performance.now() - t0) };
      } catch (err) {
        out[name] = { pass: false, error: String(err) };
      }
    }
    out.summary = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, (v as { pass: boolean }).pass]));
    return out;
  }

  const sim = {
    THREE,
    engine,
    engineKind,
    player,
    npcs,
    world,
    events,
    get time() {
      return simTime;
    },
    step,
    stepAsync,
    render,
    keys,
    look: (yawDeg: number, pitchDeg: number) => player.setLook(yawDeg * DEG, pitchDeg * DEG),
    setBehaviour,
    scenario: applyScenario,
    reset,
    state,
    checks,
    runChecks,
    v3,
  };
  (window as unknown as { __sim: typeof sim }).__sim = sim;
  log('ready', { engine: engineKind, humans: realHuman ? 'real' : 'stub', body: BODY, nolock: NOLOCK, paused: PAUSED });
}

void main();
