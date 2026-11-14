/**
 * Tiny procedural mesh builder: vertex-coloured, optionally skinned, built from
 * lofted rings. Everything a character is made of goes through here.
 */
import * as THREE from 'three';

/** Bone weights for a vertex: [boneIndex, weight] pairs (normalised on write, max 4). */
export type BW = ReadonlyArray<readonly [number, number]>;
export type V3 = readonly [number, number, number];

export class GeoBuilder {
  pos: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  skinI: number[] = [];
  skinW: number[] = [];

  constructor(readonly skinned: boolean) {}

  get count(): number {
    return this.pos.length / 3;
  }

  v(x: number, y: number, z: number, c: THREE.Color, w?: BW): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    if (this.skinned) {
      const ws = w && w.length ? [...w].filter((e) => e[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4) : [[0, 1] as const];
      let sum = 0;
      for (const e of ws) sum += e[1];
      for (let k = 0; k < 4; k++) {
        const e = ws[k];
        this.skinI.push(e ? e[0] : 0);
        this.skinW.push(e ? e[1] / sum : 0);
      }
    }
    return i;
  }

  tri(a: number, b: number, c: number): void {
    if (a === b || b === c || a === c) return;
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number, flip = false): void {
    if (flip) {
      this.tri(a, c, b);
      this.tri(a, d, c);
    } else {
      this.tri(a, b, c);
      this.tri(a, c, d);
    }
  }

  /** Recolour vertices added since `from` with fn(x, y, z, current) -> colour. */
  recolor(from: number, fn: (x: number, y: number, z: number, c: THREE.Color) => void): void {
    const c = new THREE.Color();
    for (let i = from; i < this.count; i++) {
      c.setRGB(this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2]);
      fn(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2], c);
      this.col[i * 3] = c.r;
      this.col[i * 3 + 1] = c.g;
      this.col[i * 3 + 2] = c.b;
    }
  }

  /** Apply a transform to vertices added since `from`. */
  transform(from: number, m: THREE.Matrix4): void {
    const p = new THREE.Vector3();
    for (let i = from; i < this.count; i++) {
      p.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]).applyMatrix4(m);
      this.pos[i * 3] = p.x;
      this.pos[i * 3 + 1] = p.y;
      this.pos[i * 3 + 2] = p.z;
    }
  }

  build(opts: { weld?: boolean; dynamic?: boolean } = {}): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(this.pos), 3);
    if (opts.dynamic) pos.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pos);
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    if (this.skinned) {
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.skinI, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.skinW, 4));
    }
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeVertexNormals();
    if (opts.dynamic) (g.getAttribute('normal') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    if (opts.weld) weldNormals(g);
    return g;
  }
}

/** Average the normals of vertices that share a position (hides colour-seam creases). */
export function weldNormals(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  const map = new Map<string, number[]>();
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 20000)},${Math.round(pos.getY(i) * 20000)},${Math.round(pos.getZ(i) * 20000)}`;
    const list = map.get(k);
    if (list) list.push(i);
    else map.set(k, [i]);
  }
  const n = new THREE.Vector3();
  for (const list of map.values()) {
    if (list.length < 2) continue;
    n.set(0, 0, 0);
    for (const i of list) n.x += nrm.getX(i), (n.y += nrm.getY(i)), (n.z += nrm.getZ(i));
    if (n.lengthSq() < 1e-10) continue;
    n.normalize();
    for (const i of list) nrm.setXYZ(i, n.x, n.y, n.z);
  }
  nrm.needsUpdate = true;
}

export interface Ring {
  /** Centre of the ring. */
  c: V3;
  /** Radius along u and along v. */
  rx: number;
  rz: number;
  /** Ring plane basis. Default u = +X, v = +Z (a horizontal ring; theta 0 = +X, 90deg = +Z = front). */
  u?: V3;
  v?: V3;
  col: THREE.Color | ((theta: number, x: number, y: number, z: number) => THREE.Color);
  w?: BW | ((x: number, y: number, z: number, theta: number) => BW);
  /** Superellipse exponent: 2 = ellipse, larger = boxier. */
  n?: number;
  /** Per-angle radius multiplier. */
  shape?: (theta: number) => number;
}

export interface LoftOpts {
  segs: number;
  capStart?: boolean;
  capEnd?: boolean;
  /** Open shell between two angles (radians) instead of a closed tube. */
  arc?: readonly [number, number];
  /** Force the winding instead of deriving it from the direction of travel. */
  flip?: boolean;
}

const X: V3 = [1, 0, 0];
const Z: V3 = [0, 0, 1];

function spow(c: number, e: number): number {
  return c < 0 ? -Math.pow(-c, e) : Math.pow(c, e);
}

/** Skin a tube (or open shell) through a list of rings. Returns the index of the first vertex. */
export function loft(b: GeoBuilder, rings: Ring[], o: LoftOpts): number {
  const first = b.count;
  const open = !!o.arc;
  const cols = open ? o.segs + 1 : o.segs;
  const a0 = open ? o.arc![0] : 0;
  const a1 = open ? o.arc![1] : Math.PI * 2;
  const start: number[] = [];
  for (const r of rings) {
    const u = r.u ?? X;
    const v = r.v ?? Z;
    const e = 2 / (r.n ?? 2);
    start.push(b.count);
    for (let i = 0; i < cols; i++) {
      const th = a0 + ((a1 - a0) * i) / o.segs;
      const m = r.shape ? r.shape(th) : 1;
      const cu = spow(Math.cos(th), e) * r.rx * m;
      const cv = spow(Math.sin(th), e) * r.rz * m;
      const x = r.c[0] + u[0] * cu + v[0] * cv;
      const y = r.c[1] + u[1] * cu + v[1] * cv;
      const z = r.c[2] + u[2] * cu + v[2] * cv;
      const col = typeof r.col === 'function' ? r.col(th, x, y, z) : r.col;
      const w = typeof r.w === 'function' ? r.w(x, y, z, th) : r.w;
      b.v(x, y, z, col, w);
    }
  }
  // Winding: outward when the rings travel along u x v.
  const r0 = rings[0];
  const rl = rings[rings.length - 1];
  const u0 = r0.u ?? X;
  const v0 = r0.v ?? Z;
  const cx = u0[1] * v0[2] - u0[2] * v0[1];
  const cy = u0[2] * v0[0] - u0[0] * v0[2];
  const cz = u0[0] * v0[1] - u0[1] * v0[0];
  const d = (rl.c[0] - r0.c[0]) * cx + (rl.c[1] - r0.c[1]) * cy + (rl.c[2] - r0.c[2]) * cz;
  const flip = o.flip ?? d < 0;
  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < o.segs; i++) {
      const j = open ? i + 1 : (i + 1) % cols;
      b.quad(start[k] + i, start[k] + j, start[k + 1] + j, start[k + 1] + i, flip);
    }
  }
  const cap = (ri: number, atStart: boolean): void => {
    const r = rings[ri];
    const col = typeof r.col === 'function' ? r.col(0, r.c[0], r.c[1], r.c[2]) : r.col;
    const w = typeof r.w === 'function' ? r.w(r.c[0], r.c[1], r.c[2], 0) : r.w;
    const c = b.v(r.c[0], r.c[1], r.c[2], col, w);
    for (let i = 0; i < o.segs; i++) {
      const j = open ? i + 1 : (i + 1) % cols;
      // start cap faces against the travel direction, end cap along it
      if (atStart !== flip) b.tri(c, start[ri] + j, start[ri] + i);
      else b.tri(c, start[ri] + i, start[ri] + j);
    }
  };
  if (o.capStart) cap(0, true);
  if (o.capEnd) cap(rings.length - 1, false);
  return first;
}

/** Rounded box as a 3-ring loft along Y, used for bags, phones, soles. */
export function box(
  b: GeoBuilder,
  c: V3,
  hx: number,
  hy: number,
  hz: number,
  col: THREE.Color,
  w?: BW,
  n = 5,
  segs = 12,
): number {
  const mk = (y: number, s: number): Ring => ({ c: [c[0], c[1] + y, c[2]], rx: hx * s, rz: hz * s, col, w, n });
  return loft(b, [mk(-hy, 0.9), mk(-hy * 0.86, 1), mk(hy * 0.86, 1), mk(hy, 0.9)], { segs, capStart: true, capEnd: true });
}

/** UV-sphere-ish ellipsoid. */
export function ellipsoid(b: GeoBuilder, c: V3, rx: number, ry: number, rz: number, col: THREE.Color, w?: BW, segs = 10, rows = 6): number {
  const rings: Ring[] = [];
  for (let k = 1; k < rows; k++) {
    const a = (Math.PI * k) / rows;
    rings.push({ c: [c[0], c[1] - Math.cos(a) * ry, c[2]], rx: Math.sin(a) * rx, rz: Math.sin(a) * rz, col, w });
  }
  const first = b.count;
  loft(b, rings, { segs });
  // close the poles with proper tips
  const bottom = b.v(c[0], c[1] - ry, c[2], col, w);
  const top = b.v(c[0], c[1] + ry, c[2], col, w);
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs;
    b.tri(bottom, first + i, first + j);
    b.tri(top, first + (rows - 2) * segs + j, first + (rows - 2) * segs + i);
  }
  return first;
}

/** Thin tube through a polyline, rings perpendicular to the path. */
export function tubePath(
  b: GeoBuilder,
  pts: V3[],
  rx: number | number[],
  rz: number | number[],
  col: THREE.Color,
  w: BW | ((x: number, y: number, z: number) => BW),
  segs = 6,
  caps = true,
  refUp: V3 = [0, 0, 1],
): number {
  const rings: Ring[] = [];
  const t = new THREE.Vector3();
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  const ref = new THREE.Vector3(...refUp);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const c = pts[Math.min(pts.length - 1, i + 1)];
    t.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]).normalize();
    u.crossVectors(ref, t);
    if (u.lengthSq() < 1e-6) u.set(1, 0, 0).cross(t);
    u.normalize();
    v.crossVectors(t, u).normalize();
    rings.push({
      c: pts[i],
      rx: Array.isArray(rx) ? rx[i] : rx,
      rz: Array.isArray(rz) ? rz[i] : rz,
      u: [u.x, u.y, u.z],
      v: [v.x, v.y, v.z],
      col,
      w: typeof w === 'function' ? (x, y, z) => w(x, y, z) : w,
    });
  }
  return loft(b, rings, { segs, capStart: caps, capEnd: caps, flip: false });
}

