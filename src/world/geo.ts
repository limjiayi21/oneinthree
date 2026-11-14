/**
 * Geometry batching. Everything static in the street is written through a Pen
 * into a handful of merged BufferGeometries (one per material per street
 * chunk), which is what keeps the draw-call count low.
 */

import * as THREE from 'three';

/** Deterministic RNG so the block is identical on every load. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type MatKey =
  | 'asphalt' // wet road surface (tiling texture)
  | 'sidewalk' // concrete slabs (tiling texture)
  | 'brick' // facades (tiling texture x vertex tint)
  | 'matte' // atlas x vertex colour, diffuse only: props (these cast shadows)
  | 'trim' // same material as matte, for facade detail that should not cast shadows
  | 'gloss' // atlas x vertex colour, specular: cars, bags, wet metal
  | 'lit' // atlas x vertex colour, unlit: lamps, neon, lit windows, shop interior
  | 'decal' // atlas, alpha blended, lit: road paint, stains, graffiti
  | 'puddle' // dark mirror-ish water
  | 'glass'; // shop window glass

export interface UVRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

class Batch {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  count = 0;
}

/** Street chunks along Z for frustum culling. */
export function chunkOf(z: number): string {
  if (z > 8) return 'near';
  if (z < -140) return 'far';
  return 'c' + Math.min(4, Math.max(0, Math.floor((8 - z) / 30)));
}

export class Builder {
  private batches = new Map<string, Batch>();

  get(mat: MatKey, chunk: string): Batch {
    const key = mat + '|' + chunk;
    let b = this.batches.get(key);
    if (!b) {
      b = new Batch();
      this.batches.set(key, b);
    }
    return b;
  }

  /** Turn every batch into a mesh. */
  build(materials: Record<MatKey, THREE.Material>, opts: { cast: MatKey[]; receive: MatKey[] }): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [key, b] of this.batches) {
      if (b.count === 0) continue;
      const mat = key.split('|')[0] as MatKey;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.pos), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(b.nor), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.uv), 2));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.col), 3));
      g.setIndex(new THREE.BufferAttribute(b.count > 65535 ? new Uint32Array(b.idx) : new Uint16Array(b.idx), 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const mesh = new THREE.Mesh(g, materials[mat]);
      mesh.name = key;
      mesh.castShadow = opts.cast.includes(mat);
      mesh.receiveShadow = opts.receive.includes(mat);
      mesh.matrixAutoUpdate = false;
      if (mat === 'decal') mesh.renderOrder = 2;
      if (mat === 'puddle') mesh.renderOrder = 1;
      if (mat === 'glass') mesh.renderOrder = 5;
      out.push(mesh);
    }
    this.batches.clear();
    return out;
  }
}

const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * A stateful drawing head: current batch, transform, colour and UV mode.
 * Local coordinates are pushed through the current matrix as they are written.
 */
export class Pen {
  readonly m = new THREE.Matrix4();
  private nm = new THREE.Matrix3();
  private stack: THREE.Matrix4[] = [];
  private b!: Batch;
  private cr = 1;
  private cg = 1;
  private cb = 1;
  private aoBottom = 1;
  private aoTop = 1;
  private worldU = 0; // 0 = white texel / explicit rect
  private worldV = 0;
  private wu: number;
  private wv: number;

  constructor(
    private builder: Builder,
    white: UVRect,
  ) {
    this.wu = (white.u0 + white.u1) / 2;
    this.wv = (white.v0 + white.v1) / 2;
    this.b = builder.get('matte', 'c0');
  }

  /* ---------------------------------------------------------------- state */

  /** Select the target batch by material and world z. */
  to(mat: MatKey, z: number): this {
    this.b = this.builder.get(mat, chunkOf(z));
    return this;
  }
  toChunk(mat: MatKey, chunk: string): this {
    this.b = this.builder.get(mat, chunk);
    return this;
  }
  color(hex: number, mul = 1): this {
    _c.setHex(hex);
    this.cr = _c.r * mul;
    this.cg = _c.g * mul;
    this.cb = _c.b * mul;
    return this;
  }
  /** Linear RGB directly (may exceed 1 for emissive surfaces). */
  rgb(r: number, g: number, b: number): this {
    this.cr = r;
    this.cg = g;
    this.cb = b;
    return this;
  }
  /** Vertical gradient multiplier (cheap fake occlusion): bottom and top of the next shapes. */
  ao(bottom: number, top: number): this {
    this.aoBottom = bottom;
    this.aoTop = top;
    return this;
  }
  /** UVs from local coordinates divided by these sizes (tiling textures). 0 = back to the white texel. */
  worldUV(su = 0, sv = 0): this {
    this.worldU = su;
    this.worldV = sv;
    return this;
  }
  identity(): this {
    this.m.identity();
    this.nm.identity();
    return this;
  }
  /** Reset to a frame at (x,y,z) rotated about Y. */
  frame(x: number, y: number, z: number, rotY = 0): this {
    this.m.makeRotationY(rotY).setPosition(x, y, z);
    this.nm.setFromMatrix4(this.m);
    return this;
  }
  push(): this {
    this.stack.push(this.m.clone());
    return this;
  }
  pop(): this {
    const m = this.stack.pop();
    if (m) {
      this.m.copy(m);
      this.nm.getNormalMatrix(this.m);
    }
    return this;
  }
  move(x: number, y: number, z: number): this {
    _m.makeTranslation(x, y, z);
    this.m.multiply(_m);
    return this;
  }
  rot(rx: number, ry: number, rz: number): this {
    _m.makeRotationFromEuler(_e.set(rx, ry, rz, 'YXZ'));
    this.m.multiply(_m);
    this.nm.getNormalMatrix(this.m);
    return this;
  }
  scale(x: number, y: number, z: number): this {
    _m.makeScale(x, y, z);
    this.m.multiply(_m);
    this.nm.getNormalMatrix(this.m);
    return this;
  }

  /* ----------------------------------------------------------- primitives */

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, shade: number): number {
    const b = this.b;
    _v.set(x, y, z).applyMatrix4(this.m);
    _n.set(nx, ny, nz).applyMatrix3(this.nm).normalize();
    b.pos.push(_v.x, _v.y, _v.z);
    b.nor.push(_n.x, _n.y, _n.z);
    b.uv.push(u, v);
    b.col.push(this.cr * shade, this.cg * shade, this.cb * shade);
    return b.count++;
  }

  /**
   * Quad a,b,c,d counter-clockwise seen from the front; a,b are treated as the
   * bottom edge for the ao gradient. `r` maps a->(u0,v0) b->(u1,v0) c->(u1,v1) d->(u0,v1).
   */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    r?: UVRect,
    uvw?: [number, number, number, number, number, number, number, number],
  ): this {
    _a.set(bx - ax, by - ay, bz - az);
    _b.set(dx - ax, dy - ay, dz - az);
    _d.crossVectors(_a, _b).normalize();
    const nx = _d.x, ny = _d.y, nz = _d.z;
    let u = [this.wu, this.wv, this.wu, this.wv, this.wu, this.wv, this.wu, this.wv];
    if (r) u = [r.u0, r.v0, r.u1, r.v0, r.u1, r.v1, r.u0, r.v1];
    else if (uvw) u = uvw;
    const i0 = this.vert(ax, ay, az, nx, ny, nz, u[0], u[1], this.aoBottom);
    const i1 = this.vert(bx, by, bz, nx, ny, nz, u[2], u[3], this.aoBottom);
    const i2 = this.vert(cx, cy, cz, nx, ny, nz, u[4], u[5], this.aoTop);
    const i3 = this.vert(dx, dy, dz, nx, ny, nz, u[6], u[7], this.aoTop);
    this.b.idx.push(i0, i1, i2, i0, i2, i3);
    return this;
  }

  /** Triangle a,b,c counter-clockwise seen from the front. */
  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): this {
    _a.set(bx - ax, by - ay, bz - az);
    _b.set(cx - ax, cy - ay, cz - az);
    _d.crossVectors(_a, _b).normalize();
    const i0 = this.vert(ax, ay, az, _d.x, _d.y, _d.z, this.wu, this.wv, 1);
    const i1 = this.vert(bx, by, bz, _d.x, _d.y, _d.z, this.wu, this.wv, 1);
    const i2 = this.vert(cx, cy, cz, _d.x, _d.y, _d.z, this.wu, this.wv, 1);
    this.b.idx.push(i0, i1, i2);
    return this;
  }

  /** Convex polygon in the local ZY plane at x (points as [z, y]), facing +X (dir 1) or -X (dir -1). */
  polyZY(pts: Array<[number, number]>, x: number, dir: 1 | -1): this {
    // signed area in (z, y): positive = counter-clockwise when looking down -X (i.e. from +X)
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      area += p[0] * q[1] - q[0] * p[1];
    }
    // seen from +X, +Z runs to the left, so a ccw polygon in (z, y) is clockwise on screen
    const flip = (area > 0) === (dir > 0);
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[0], b = pts[i], c = pts[i + 1];
      if (flip) this.tri(x, a[1], a[0], x, c[1], c[0], x, b[1], b[0]);
      else this.tri(x, a[1], a[0], x, b[1], b[0], x, c[1], c[0]);
    }
    return this;
  }

  /** Rectangle in the local XY plane at depth z, facing +Z (or -Z when flip). */
  rectXY(x0: number, y0: number, x1: number, y1: number, z: number, r?: UVRect, flip = false): this {
    let uvw: [number, number, number, number, number, number, number, number] | undefined;
    if (!r && this.worldU > 0) {
      const su = this.worldU, sv = this.worldV;
      uvw = flip
        ? [x1 / su, y0 / sv, x0 / su, y0 / sv, x0 / su, y1 / sv, x1 / su, y1 / sv]
        : [x0 / su, y0 / sv, x1 / su, y0 / sv, x1 / su, y1 / sv, x0 / su, y1 / sv];
    }
    if (flip) return this.quad(x1, y0, z, x0, y0, z, x0, y1, z, x1, y1, z, r, uvw);
    return this.quad(x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z, r, uvw);
  }

  /** Rectangle in the local ZY plane at x, facing +X (dir=1) or -X (dir=-1). */
  rectZY(z0: number, y0: number, z1: number, y1: number, x: number, dir: 1 | -1, r?: UVRect): this {
    let uvw: [number, number, number, number, number, number, number, number] | undefined;
    const zl = Math.min(z0, z1), zh = Math.max(z0, z1);
    if (!r && this.worldU > 0) {
      const su = this.worldU, sv = this.worldV;
      uvw = dir > 0
        ? [zh / su, y0 / sv, zl / su, y0 / sv, zl / su, y1 / sv, zh / su, y1 / sv]
        : [zl / su, y0 / sv, zh / su, y0 / sv, zh / su, y1 / sv, zl / su, y1 / sv];
    }
    if (dir > 0) return this.quad(x, y0, zh, x, y0, zl, x, y1, zl, x, y1, zh, r, uvw);
    return this.quad(x, y0, zl, x, y0, zh, x, y1, zh, x, y1, zl, r, uvw);
  }

  /** Horizontal rectangle at height y facing up (or down when flip). u runs along +X, v along -Z. */
  rectXZ(x0: number, z0: number, x1: number, z1: number, y: number, r?: UVRect, flip = false): this {
    const zl = Math.min(z0, z1), zh = Math.max(z0, z1);
    let uvw: [number, number, number, number, number, number, number, number] | undefined;
    if (!r && this.worldU > 0) {
      const su = this.worldU, sv = this.worldV;
      uvw = flip
        ? [x0 / su, zl / sv, x1 / su, zl / sv, x1 / su, zh / sv, x0 / su, zh / sv]
        : [x0 / su, zh / sv, x1 / su, zh / sv, x1 / su, zl / sv, x0 / su, zl / sv];
    }
    const t = this.aoBottom;
    this.aoBottom = this.aoTop; // flat surfaces take the "top" shade throughout
    if (flip) this.quad(x0, y, zl, x1, y, zl, x1, y, zh, x0, y, zh, r, uvw);
    else this.quad(x0, y, zh, x1, y, zh, x1, y, zl, x0, y, zl, r, uvw);
    this.aoBottom = t;
    return this;
  }

  /**
   * Axis-aligned (in local space) box centred at (cx, cy, cz).
   * skip: string of faces to omit, any of "x X y Y z Z" (lowercase = negative side).
   */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, skip = ''): this {
    const x0 = cx - sx / 2, x1 = cx + sx / 2;
    const y0 = cy - sy / 2, y1 = cy + sy / 2;
    const z0 = cz - sz / 2, z1 = cz + sz / 2;
    if (!skip.includes('Z')) this.rectXY(x0, y0, x1, y1, z1);
    if (!skip.includes('z')) this.rectXY(x0, y0, x1, y1, z0, undefined, true);
    if (!skip.includes('X')) this.rectZY(z0, y0, z1, y1, x1, 1);
    if (!skip.includes('x')) this.rectZY(z0, y0, z1, y1, x0, -1);
    if (!skip.includes('Y')) this.rectXZ(x0, z0, x1, z1, y1);
    if (!skip.includes('y')) {
      const t = this.aoTop;
      this.aoTop = this.aoBottom;
      this.rectXZ(x0, z0, x1, z1, y0, undefined, true);
      this.aoTop = t;
    }
    return this;
  }

  /** Box given by min corner and size: handy for architecture. */
  boxMin(x0: number, y0: number, z0: number, sx: number, sy: number, sz: number, skip = ''): this {
    return this.box(x0 + sx / 2, y0 + sy / 2, z0 + sz / 2, sx, sy, sz, skip);
  }

  /** Cylinder / cone frustum along local Y from y to y+h. caps: 1 = bottom, 2 = top, 3 = both. */
  cyl(cx: number, y: number, cz: number, rBot: number, rTop: number, h: number, seg = 8, caps = 2): this {
    const b = this.b;
    const base = b.count;
    const slope = (rBot - rTop) / (h || 1);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      this.vert(cx + c * rBot, y, cz + s * rBot, c, slope, s, this.wu, this.wv, this.aoBottom);
      this.vert(cx + c * rTop, y + h, cz + s * rTop, c, slope, s, this.wu, this.wv, this.aoTop);
    }
    for (let i = 0; i < seg; i++) {
      const k = base + i * 2;
      b.idx.push(k, k + 1, k + 3, k, k + 3, k + 2);
    }
    if (caps & 2 && rTop > 0.0001) this.disc(cx, y + h, cz, rTop, seg, 1, this.aoTop);
    if (caps & 1 && rBot > 0.0001) this.disc(cx, y, cz, rBot, seg, -1, this.aoBottom);
    return this;
  }

  /** Horizontal disc facing up (dir 1) or down (dir -1). */
  disc(cx: number, y: number, cz: number, r: number, seg = 10, dir: 1 | -1 = 1, shade = 1, rect?: UVRect): this {
    const b = this.b;
    const uc = rect ? (rect.u0 + rect.u1) / 2 : this.wu;
    const vc = rect ? (rect.v0 + rect.v1) / 2 : this.wv;
    const ur = rect ? (rect.u1 - rect.u0) / 2 : 0;
    const vr = rect ? (rect.v1 - rect.v0) / 2 : 0;
    const centre = this.vert(cx, y, cz, 0, dir, 0, uc, vc, shade);
    const first = b.count;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      this.vert(cx + c * r, y, cz + s * r, 0, dir, 0, uc + c * ur, vc - s * vr, shade);
    }
    for (let i = 0; i < seg; i++) {
      if (dir > 0) b.idx.push(centre, first + i + 1, first + i);
      else b.idx.push(centre, first + i, first + i + 1);
    }
    return this;
  }

  /** Tapered tube between two local points. */
  tube(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r0: number, r1 = r0, seg = 6, caps = 0): this {
    _a.set(x1 - x0, y1 - y0, z1 - z0);
    const len = _a.length();
    if (len < 1e-5) return this;
    _a.multiplyScalar(1 / len);
    _q.setFromUnitVectors(UP, _a);
    this.push();
    _m.compose(_b.set(x0, y0, z0), _q, _s);
    this.m.multiply(_m);
    this.nm.getNormalMatrix(this.m);
    this.cyl(0, 0, 0, r0, r1, len, seg, caps);
    this.pop();
    return this;
  }

  /** Append any BufferGeometry with the current transform and colour. */
  geom(g: THREE.BufferGeometry, rect?: UVRect): this {
    const b = this.b;
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const base = b.count;
    for (let i = 0; i < pos.count; i++) {
      let u = this.wu, v = this.wv;
      if (rect && uv) {
        u = rect.u0 + (rect.u1 - rect.u0) * uv.getX(i);
        v = rect.v0 + (rect.v1 - rect.v0) * uv.getY(i);
      }
      this.vert(pos.getX(i), pos.getY(i), pos.getZ(i), nor ? nor.getX(i) : 0, nor ? nor.getY(i) : 1, nor ? nor.getZ(i) : 0, u, v, 1);
    }
    const index = g.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) b.idx.push(base + index.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) b.idx.push(base + i);
    }
    return this;
  }

  /** Flat convex polygon fan (points in local XZ at height y), facing up. */
  fanXZ(pts: Array<[number, number]>, y: number): this {
    const b = this.b;
    let cx = 0, cz = 0;
    for (const p of pts) {
      cx += p[0];
      cz += p[1];
    }
    cx /= pts.length;
    cz /= pts.length;
    const c = this.vert(cx, y, cz, 0, 1, 0, this.wu, this.wv, 1);
    const first = b.count;
    for (const p of pts) this.vert(p[0], y, p[1], 0, 1, 0, this.wu, this.wv, 1);
    // decide winding so the face points up
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      area += p[0] * q[1] - q[0] * p[1];
    }
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      if (area > 0) b.idx.push(c, first + j, first + i);
      else b.idx.push(c, first + i, first + j);
    }
    return this;
  }
}
