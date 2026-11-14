/**
 * Standalone harness for the engine + street (dev/world.html).
 * Not part of the app: a debug camera, overlays for colliders / zones / points,
 * and keys to fire the world's events.
 *
 *   URL params   x, y, z, yaw, pitch (degrees; yaw 0 faces -Z, 90 faces -X), fov
 *                walk=1        start in walk mode (eye height, collisions)
 *                overhead=1    look straight down from h metres (default 70)
 *                nofog=1 bright=1   for layout views
 *                debug=1       draw colliders (red), zones (cyan), bounds (white), points (yellow)
 *                dummies=1     stand-in figures at the character spots
 *                fear=0..1     post-processing fear level
 *   Keys         WASD move, Q/E down/up, Shift fast, drag to look, G walk/fly
 *                1 alley event   2 / 3 passing car (+Z / -Z)   4 home door   5 shop door
 *                F / V fear up / down   P pulse   B debug overlay   M dummies
 */

import * as THREE from 'three';
import type { Rect, StreetWorld } from '../contracts';
import { createEngine, type EngineDebug } from '../engine/engine';
import { createStreet } from './street';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number): number => {
  const v = params.get(k);
  return v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v);
};
const flag = (k: string): boolean => params.get(k) === '1' || params.get(k) === 'true';

const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const hud = document.querySelector<HTMLDivElement>('#hud')!;
const engine = createEngine(canvas) as EngineDebug;
const t0 = performance.now();
const world: StreetWorld = createStreet(engine);
const buildMs = performance.now() - t0;
const { camera, scene } = engine;

/* ------------------------------------------------------------- camera */

const spawn = world.points.subwayExit;
const cam = {
  x: num('x', spawn.x),
  y: num('y', 1.62),
  z: num('z', spawn.z),
  yaw: THREE.MathUtils.degToRad(num('yaw', 0)),
  pitch: THREE.MathUtils.degToRad(num('pitch', 0)),
  walk: flag('walk'),
};
if (flag('overhead')) {
  cam.y = num('h', 70);
  cam.pitch = -Math.PI / 2;
  cam.x = num('x', 0);
  cam.z = num('z', -66);
}
camera.fov = num('fov', 70);
camera.updateProjectionMatrix();

if (flag('nofog') && scene.fog) (scene.fog as THREE.FogExp2).density = 0.0008;
if (flag('bright')) scene.add(new THREE.AmbientLight(0xffffff, 1.6));
engine.setFear(num('fear', 0));

const keys = new Set<string>();
let dragging = false;
canvas.addEventListener('mousedown', () => (dragging = true));
window.addEventListener('mouseup', () => (dragging = false));
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  cam.yaw -= e.movementX * 0.0032;
  cam.pitch = Math.max(-1.55, Math.min(1.55, cam.pitch - e.movementY * 0.0032));
});

function collide(): void {
  const r = 0.3;
  for (let pass = 0; pass < 2; pass++) {
    for (const c of world.colliders) {
      if (cam.x < c.minX - r || cam.x > c.maxX + r || cam.z < c.minZ - r || cam.z > c.maxZ + r) continue;
      const pushes = [cam.x - (c.minX - r), c.maxX + r - cam.x, cam.z - (c.minZ - r), c.maxZ + r - cam.z];
      const m = Math.min(...pushes);
      if (m === pushes[0]) cam.x = c.minX - r;
      else if (m === pushes[1]) cam.x = c.maxX + r;
      else if (m === pushes[2]) cam.z = c.minZ - r;
      else cam.z = c.maxZ + r;
    }
  }
  const b = world.bounds;
  cam.x = Math.min(b.maxX - r, Math.max(b.minX + r, cam.x));
  cam.z = Math.min(b.maxZ - r, Math.max(b.minZ + r, cam.z));
}

function applyCamera(): void {
  camera.position.set(cam.x, cam.y, cam.z);
  camera.rotation.set(cam.pitch, cam.yaw, 0, 'YXZ');
}

/* ------------------------------------------------------- debug overlay */

const overlay = new THREE.Group();
overlay.visible = flag('debug');
scene.add(overlay);

function rectLines(rects: Rect[], y: number, color: number): THREE.LineSegments {
  const pts: number[] = [];
  for (const r of rects) {
    const c = [r.minX, r.minZ, r.maxX, r.minZ, r.maxX, r.maxZ, r.minX, r.maxZ];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      pts.push(c[i * 2], y, c[i * 2 + 1], c[j * 2], y, c[j * 2 + 1]);
    }
    // a cross so thin rects still show
    pts.push(r.minX, y, r.minZ, r.maxX, y, r.maxZ);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const m = new THREE.LineBasicMaterial({ color, fog: false, depthTest: false, transparent: true });
  const l = new THREE.LineSegments(g, m);
  l.renderOrder = 100;
  l.frustumCulled = false;
  return l;
}

function label(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 48;
  const ctx = c.getContext('2d')!;
  ctx.font = '600 26px monospace';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, 256, 48);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 6, 25, 244);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, fog: false, depthTest: false, transparent: true }));
  s.scale.set(2.4, 0.45, 1);
  s.renderOrder = 101;
  return s;
}

overlay.add(rectLines(world.colliders, 0.06, 0xff3b30));
overlay.add(rectLines(Object.values(world.zones), 0.1, 0x30d5ff));
overlay.add(rectLines([world.bounds], 0.14, 0xffffff));
for (const [name, p] of Object.entries(world.points)) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([p.x - 0.3, 0.1, p.z, p.x + 0.3, 0.1, p.z, p.x, 0.1, p.z - 0.3, p.x, 0.1, p.z + 0.3, p.x, 0, p.z, p.x, 1.8, p.z], 3));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffd60a, fog: false, depthTest: false, transparent: true }));
  l.renderOrder = 100;
  overlay.add(l);
  const s = label(name, '#ffd60a');
  s.position.set(p.x, 2.05, p.z);
  overlay.add(s);
}
for (const [name, r] of Object.entries(world.zones)) {
  if (name === 'road' || name === 'leftSidewalk' || name === 'rightSidewalk') continue;
  const s = label(name, '#30d5ff');
  s.position.set((r.minX + r.maxX) / 2, 0.6, (r.minZ + r.maxZ) / 2);
  overlay.add(s);
}

/* -------------------------------------------------------------- dummies */

const dummies = new THREE.Group();
dummies.visible = flag('dummies');
scene.add(dummies);
function dummy(p: THREE.Vector3, faceYaw: number, top: number, height = 1.78): void {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, height - 0.68, 4, 10), new THREE.MeshStandardMaterial({ color: top, roughness: 0.9 }));
  body.position.y = (height - 0.28) / 2;
  const skin = new THREE.MeshStandardMaterial({ color: 0xb98a6a, roughness: 0.75 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 10), skin);
  head.position.y = height - 0.115;
  head.scale.set(0.92, 1.12, 1);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.05), skin);
  nose.position.set(0, height - 0.13, -0.12);
  const brow = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.02, 0.03), new THREE.MeshStandardMaterial({ color: 0x2a1c14 }));
  brow.position.set(0, height - 0.08, -0.105);
  for (const m of [body, head, nose, brow]) {
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  g.position.copy(p);
  g.rotation.y = faceYaw;
  dummies.add(g);
}
// faceYaw uses the player's convention: 0 faces -Z, +90 deg faces -X
dummy(world.points.harasserSpot, Math.PI / 2, 0x23262b);
dummy(world.points.clerkSpot, Math.PI / 2, 0x4a5a3a, 1.72);
dummy(world.points.womanStartBystander, 0, 0x5a3a44, 1.66);
dummy(world.points.homeStoop, Math.PI, 0x23262b);
dummy(world.points.shopDoor, Math.PI / 2, 0x2c3440);
dummy(world.points.passerbyA0, Math.PI, 0x3a3a3a, 1.74);

/* ---------------------------------------------------------------- input */

let fear = num('fear', 0);
const doorOpen = { home: false, shop: true };
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  switch (e.code) {
    case 'Digit1':
      world.triggerAlleyEvent();
      break;
    case 'Digit2':
      world.spawnPassingCar(1);
      break;
    case 'Digit3':
      world.spawnPassingCar(-1);
      break;
    case 'Digit4':
      doorOpen.home = !doorOpen.home;
      world.setDoorOpen('home', doorOpen.home);
      break;
    case 'Digit5':
      doorOpen.shop = !doorOpen.shop;
      world.setDoorOpen('shop', doorOpen.shop);
      break;
    case 'KeyF':
      fear = Math.min(1, fear + 0.1);
      engine.setFear(fear);
      break;
    case 'KeyV':
      fear = Math.max(0, fear - 0.1);
      engine.setFear(fear);
      break;
    case 'KeyP':
      engine.pulse(1);
      break;
    case 'KeyB':
      overlay.visible = !overlay.visible;
      break;
    case 'KeyM':
      dummies.visible = !dummies.visible;
      break;
    case 'KeyG':
      cam.walk = !cam.walk;
      if (cam.walk) cam.y = 1.62;
      break;
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

/* ----------------------------------------------------------------- loop */

let fps = 60;
let hudTimer = 0;
engine.onUpdate((dt, elapsed) => {
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 14 : cam.walk ? 2.6 : 5) * dt;
  const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  if (f || s) {
    const sin = Math.sin(cam.yaw), cos = Math.cos(cam.yaw);
    cam.x += (-sin * f + cos * s) * speed;
    cam.z += (-cos * f - sin * s) * speed;
  }
  if (!cam.walk) cam.y += ((keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0)) * speed;
  if (cam.walk) {
    cam.y = 1.62;
    collide();
  }
  applyCamera();
  world.update(dt, elapsed);

  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  hudTimer -= dt;
  if (hudTimer <= 0) {
    hudTimer = 0.25;
    const zonesIn = Object.entries(world.zones)
      .filter(([, r]) => cam.x >= r.minX && cam.x <= r.maxX && cam.z >= r.minZ && cam.z <= r.maxZ)
      .map(([n]) => n)
      .join(', ');
    hud.textContent =
      `x ${cam.x.toFixed(2)}  y ${cam.y.toFixed(2)}  z ${cam.z.toFixed(2)}  yaw ${THREE.MathUtils.radToDeg(cam.yaw).toFixed(0)}  pitch ${THREE.MathUtils.radToDeg(cam.pitch).toFixed(0)}  ${cam.walk ? 'WALK' : 'FLY'}\n` +
      `draw calls ${engine.stats.sceneCalls} scene / ${engine.stats.calls} total   tris ${engine.stats.triangles}   fps ${fps.toFixed(0)}   pr ${engine.stats.pixelRatio.toFixed(2)}   build ${buildMs.toFixed(0)} ms\n` +
      `surface ${world.surfaceAt(cam.x, cam.z)}   zones [${zonesIn}]   fear ${fear.toFixed(1)}\n` +
      `1 alley  2/3 car  4 home door  5 shop door  F/V fear  P pulse  B overlay  M dummies  G walk/fly`;
  }
});

applyCamera();
engine.start();

/* Handles for driving the harness from the console / automation. */
const dbg = {
  engine,
  world,
  cam,
  overlay,
  dummies,
  setCam(x: number, y: number, z: number, yawDeg = 0, pitchDeg = 0): void {
    cam.x = x;
    cam.y = y;
    cam.z = z;
    cam.yaw = THREE.MathUtils.degToRad(yawDeg);
    cam.pitch = THREE.MathUtils.degToRad(pitchDeg);
    applyCamera();
  },
  /** Step n frames by hand (for background tabs where rAF is throttled). */
  frame(n = 1, dt = 1 / 60): { calls: number; sceneCalls: number; triangles: number } {
    for (let i = 0; i < n; i++) engine.renderOnce(dt);
    return { ...engine.stats };
  },
  stats: () => ({ ...engine.stats, buildMs, colliders: world.colliders.length }),
};
(window as unknown as { __dbg: typeof dbg }).__dbg = dbg;
