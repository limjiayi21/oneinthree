/**
 * Every texture in the street is drawn here on a canvas at start-up.
 * Tiling surfaces (brick, asphalt, sidewalk) get their own textures; all the
 * one-off details (windows, doors, signs, shop shelves, decals) share one atlas
 * so they can share materials.
 */

import * as THREE from 'three';
import { mulberry32, type UVRect } from './geo';

type Ctx = CanvasRenderingContext2D;
type Rng = () => number;

function canvasOf(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return [c, ctx];
}

const rgba = (r: number, g: number, b: number, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

/** Tileable fbm value noise, 0..1. */
function fbm(size: number, rng: Rng, periods: number[], gains: number[]): Float32Array {
  const out = new Float32Array(size * size);
  let total = 0;
  for (let o = 0; o < periods.length; o++) {
    const P = periods[o];
    const g = gains[o];
    total += g;
    const lat = new Float32Array(P * P);
    for (let i = 0; i < lat.length; i++) lat[i] = rng();
    const cell = size / P;
    for (let y = 0; y < size; y++) {
      const fy = y / cell;
      const iy = Math.floor(fy);
      let ty = fy - iy;
      ty = ty * ty * (3 - 2 * ty);
      const y0 = (iy % P) * P;
      const y1 = ((iy + 1) % P) * P;
      for (let x = 0; x < size; x++) {
        const fx = x / cell;
        const ix = Math.floor(fx);
        let tx = fx - ix;
        tx = tx * tx * (3 - 2 * tx);
        const x0 = ix % P;
        const x1 = (ix + 1) % P;
        const a = lat[y0 + x0] + (lat[y0 + x1] - lat[y0 + x0]) * tx;
        const b = lat[y1 + x0] + (lat[y1 + x1] - lat[y1 + x0]) * tx;
        out[y * size + x] += (a + (b - a) * ty) * g;
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function tex(canvas: HTMLCanvasElement, srgb: boolean, repeat: boolean, aniso: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/* ------------------------------------------------------------------ brick */

/** 2.52 m x 2.40 m of running-bond brick, near-neutral so vertex colour sets the hue. */
function brickTexture(rng: Rng, aniso: number): THREE.CanvasTexture {
  const S = 1024;
  const [c, ctx] = canvasOf(S, S);
  ctx.fillStyle = '#7d7a76';
  ctx.fillRect(0, 0, S, S);
  const rows = 32, cols = 12;
  const bh = S / rows, bw = S / cols;
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? bw / 2 : 0;
    for (let i = -1; i < cols; i++) {
      const l = 168 + rng() * 62 - (rng() < 0.07 ? 55 : 0);
      const warm = (rng() - 0.5) * 16;
      ctx.fillStyle = rgba(l + warm, l, l - warm * 0.8);
      const x = i * bw + off;
      ctx.fillRect(x + 1.6, r * bh + 1.6, bw - 3.2, bh - 3.2);
      // a chipped corner or lighter face now and then
      if (rng() < 0.18) {
        ctx.fillStyle = rgba(255, 255, 255, 0.07 + rng() * 0.08);
        ctx.fillRect(x + 2 + rng() * bw * 0.5, r * bh + 2, bw * (0.2 + rng() * 0.4), bh - 4);
      }
      // top highlight / bottom shade give a hint of relief
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(x + 1.6, r * bh + 1.6, bw - 3.2, 2);
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(x + 1.6, r * bh + bh - 4, bw - 3.2, 2.4);
    }
  }
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  const n = fbm(256, rng, [8, 32, 64], [1, 0.6, 0.4]);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const k = 0.86 + 0.22 * n[((y >> 2) & 255) * 256 + ((x >> 2) & 255)] + (rng() - 0.5) * 0.09;
      d[i] *= k;
      d[i + 1] *= k;
      d[i + 2] *= k;
    }
  }
  ctx.putImageData(img, 0, 0);
  return tex(c, true, true, aniso);
}

/* ---------------------------------------------------------------- asphalt */

function asphaltTextures(rng: Rng, aniso: number) {
  const S = 1024, H = 512;
  const wet = fbm(H, rng, [3, 6, 12, 24], [1, 0.7, 0.45, 0.25]);
  const pud = fbm(H, rng, [5, 10, 20], [1, 0.6, 0.3]);
  const fine = fbm(H, rng, [64, 128, 256], [0.5, 0.8, 1]);

  // colour: 8 m tile
  const [c, ctx] = canvasOf(S, S);
  const img = ctx.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const hx = x >> 1, hy = y >> 1;
      const w = smooth(0.46, 0.66, wet[hy * H + hx]);
      let l = 52 + (rng() - 0.5) * 20 + (fine[hy * H + hx] - 0.5) * 26;
      if (rng() < 0.03) l += 22 + rng() * 40; // exposed aggregate
      l *= 1 - 0.38 * w; // wet asphalt is darker
      d[i] = l * 0.98;
      d[i + 1] = l;
      d[i + 2] = l * 1.05;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // tar seams and old patches (wrap-safe: kept away from the tile edge)
  ctx.strokeStyle = 'rgba(8,8,10,0.55)';
  ctx.lineWidth = 3;
  for (let k = 0; k < 5; k++) {
    ctx.beginPath();
    let x = 80 + rng() * (S - 160), y = 80 + rng() * (S - 160);
    ctx.moveTo(x, y);
    for (let s = 0; s < 7; s++) {
      x = Math.min(S - 40, Math.max(40, x + (rng() - 0.5) * 150));
      y = Math.min(S - 40, Math.max(40, y + (rng() - 0.5) * 150));
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // roughness (G) : wet patches are smooth
  const [rc, rctx] = canvasOf(H, H);
  const rimg = rctx.createImageData(H, H);
  const rd = rimg.data;
  // normal map from the fine height field, flattened where wet
  const [nc, nctx] = canvasOf(H, H);
  const nimg = nctx.createImageData(H, H);
  const nd = nimg.data;
  const height = new Float32Array(H * H);
  for (let i = 0; i < H * H; i++) {
    const w = smooth(0.46, 0.66, wet[i]);
    const p = smooth(0.7, 0.8, pud[i]);
    height[i] = fine[i] * (1 - 0.75 * Math.max(w, p));
    const rough = 0.74 - 0.4 * w - 0.5 * p + (fine[i] - 0.5) * 0.16;
    const v = Math.min(255, Math.max(18, rough * 255));
    rd[i * 4] = rd[i * 4 + 1] = rd[i * 4 + 2] = v;
    rd[i * 4 + 3] = 255;
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < H; x++) {
      const i = y * H + x;
      const dx = height[y * H + ((x + 1) % H)] - height[y * H + ((x + H - 1) % H)];
      const dy = height[((y + 1) % H) * H + x] - height[((y + H - 1) % H) * H + x];
      let nx = -dx * 5.5, ny = dy * 5.5, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      nd[i * 4] = (nx * 0.5 + 0.5) * 255;
      nd[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
      nd[i * 4 + 2] = (nz * 0.5 + 0.5) * 255;
      nd[i * 4 + 3] = 255;
    }
  }
  rctx.putImageData(rimg, 0, 0);
  nctx.putImageData(nimg, 0, 0);
  return {
    map: tex(c, true, true, aniso),
    rough: tex(rc, false, true, aniso),
    normal: tex(nc, false, true, aniso),
  };
}

/* --------------------------------------------------------------- sidewalk */

/** 2.5 m x 2.5 m: four concrete flags with joints, stains and gum. */
function sidewalkTexture(rng: Rng, aniso: number): THREE.CanvasTexture {
  const S = 512;
  const [c, ctx] = canvasOf(S, S);
  const tones = [122, 112, 128, 116];
  for (let k = 0; k < 4; k++) {
    const l = tones[k] + (rng() - 0.5) * 8;
    ctx.fillStyle = rgba(l, l * 0.985, l * 0.95);
    ctx.fillRect((k % 2) * 256, (k >> 1) * 256, 256, 256);
  }
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  const n = fbm(256, rng, [4, 16, 64], [1, 0.6, 0.5]);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const k = 0.8 + 0.3 * n[((y >> 1) & 255) * 256 + ((x >> 1) & 255)] + (rng() - 0.5) * 0.14;
      d[i] *= k;
      d[i + 1] *= k;
      d[i + 2] *= k;
    }
  }
  ctx.putImageData(img, 0, 0);
  // joints
  ctx.fillStyle = 'rgba(14,14,14,0.85)';
  for (const p of [0, 256]) {
    ctx.fillRect(p - 2, 0, 4, S);
    ctx.fillRect(0, p - 2, S, 4);
    ctx.fillRect(S - 2, 0, 2, S);
    ctx.fillRect(0, S - 2, S, 2);
  }
  // gum and stains
  for (let k = 0; k < 26; k++) {
    const x = 12 + rng() * (S - 24), y = 12 + rng() * (S - 24), r = 2 + rng() * 4;
    ctx.fillStyle = rgba(18, 18, 20, 0.35 + rng() * 0.3);
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.7 + rng() * 0.5), rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let k = 0; k < 5; k++) {
    const x = 50 + rng() * (S - 100), y = 50 + rng() * (S - 100), r = 20 + rng() * 34;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(10,10,12,0.28)');
    g.addColorStop(1, 'rgba(10,10,12,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // one hairline crack
  ctx.strokeStyle = 'rgba(10,10,10,0.6)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  let cx = 300, cy = 20;
  ctx.moveTo(cx, cy);
  for (let s = 0; s < 9; s++) {
    cx += (rng() - 0.5) * 40;
    cy += 20 + rng() * 10;
    ctx.lineTo(cx, cy);
  }
  ctx.stroke();
  return tex(c, true, true, aniso);
}

/* ------------------------------------------------------------- small maps */

function glowTexture(): THREE.CanvasTexture {
  const S = 128;
  const [c, ctx] = canvasOf(S, S);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const r = Math.hypot(x - 63.5, y - 63.5) / 63.5;
      const f = Math.max(0, 1 - r);
      const v = Math.pow(f, 2.4) * 0.75 + Math.pow(f, 9) * 0.25;
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.min(255, v * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = tex(c, false, false, 1);
  return t;
}

/** Distant skyline strip: silhouettes with a scatter of lit windows, on transparent sky. */
function skylineTexture(rng: Rng): THREE.CanvasTexture {
  const W = 2048, H = 256;
  const [c, ctx] = canvasOf(W, H);
  for (let layer = 0; layer < 2; layer++) {
    let x = 0;
    while (x < W) {
      const w = 16 + rng() * 40;
      const tall = rng() < (layer === 0 ? 0.3 : 0.1);
      const h = (layer === 0 ? 90 : 46) + rng() * (tall ? 120 : 55);
      // far layer is hazier (closer to the sky), near layer is darker
      const l = layer === 0 ? 11 + rng() * 3 : 5 + rng() * 3;
      ctx.fillStyle = rgba(l, l + 5, l + 8);
      ctx.fillRect(x, H - h, w, h);
      if (tall && rng() < 0.6) {
        const mast = 12 + rng() * 22;
        ctx.fillRect(x + w * 0.45, H - h - mast, 2, mast);
        ctx.fillStyle = 'rgba(200,44,32,0.95)';
        ctx.fillRect(x + w * 0.45 - 0.5, H - h - mast - 2, 3, 3);
      }
      const lit = 0.06 + rng() * 0.16;
      for (let wy = H - h + 5; wy < H - 6; wy += 6) {
        for (let wx = x + 3; wx < x + w - 3; wx += 5) {
          if (rng() < lit) {
            const warm = rng() < 0.72;
            const a = 0.35 + rng() * 0.6;
            ctx.fillStyle = warm ? rgba(232, 184, 112, a) : rgba(176, 206, 232, a);
            ctx.fillRect(wx, wy, 2, 3);
          }
        }
      }
      x += w + (rng() < 0.25 ? rng() * 14 : 0);
    }
  }
  // the foot of the skyline dissolves into the haze
  const g = ctx.createLinearGradient(0, H * 0.72, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';
  const t = tex(c, true, false, 4);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** Tiny equirect "night city" used only for reflections in water, glass and car paint. */
function envTexture(rng: Rng): THREE.CanvasTexture {
  const W = 256, H = 128;
  const [c, ctx] = canvasOf(W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#04070a');
  g.addColorStop(0.42, '#0b141a');
  g.addColorStop(0.5, '#141f26');
  g.addColorStop(0.52, '#06090b');
  g.addColorStop(1, '#030405');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // building masses with a few lit windows around the horizon
  for (let x = 0; x < W; x += 6 + rng() * 10) {
    const h = 8 + rng() * 26;
    ctx.fillStyle = '#05080a';
    ctx.fillRect(x, H / 2 - h, 9, h);
    for (let k = 0; k < 3; k++) {
      if (rng() < 0.35) {
        ctx.fillStyle = rng() < 0.75 ? 'rgba(255,196,120,0.9)' : 'rgba(190,220,255,0.8)';
        ctx.fillRect(x + 1 + rng() * 6, H / 2 - 2 - rng() * (h - 2), 2, 2);
      }
    }
  }
  // street lamps
  for (let k = 0; k < 7; k++) {
    const x = rng() * W, y = H / 2 - 6 - rng() * 14, r = 5 + rng() * 5;
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    const warm = rng() < 0.75;
    rg.addColorStop(0, warm ? 'rgba(255,190,110,1)' : 'rgba(210,228,255,1)');
    rg.addColorStop(0.25, warm ? 'rgba(255,170,90,0.55)' : 'rgba(190,215,255,0.5)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.needsUpdate = true;
  return t;
}

/* ------------------------------------------------------------------ atlas */

class Atlas {
  readonly size = 2048;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: Ctx;
  readonly regions: Record<string, UVRect> = {};
  private pending: Array<{ name: string; w: number; h: number; draw: (ctx: Ctx, w: number, h: number) => void }> = [];

  constructor() {
    [this.canvas, this.ctx] = canvasOf(this.size, this.size);
  }

  add(name: string, w: number, h: number, draw: (ctx: Ctx, w: number, h: number) => void): void {
    this.pending.push({ name, w, h, draw });
  }

  /** Shelf-pack (tallest first) and draw everything. */
  finish(): void {
    const S = this.size;
    const pad = 6;
    const ctx = this.ctx;
    const c = this.canvas;
    let x = 0, y = 0, rowH = 0;
    this.pending.sort((a, b) => b.h - a.h);
    for (const { name, w, h, draw } of this.pending) {
      if (x + w + pad * 2 > S) {
        x = 0;
        y += rowH;
        rowH = 0;
      }
      if (y + h + pad * 2 > S) throw new Error('texture atlas is full at ' + name);
      const px = x + pad, py = y + pad;
      ctx.save();
      ctx.translate(px, py);
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();
      draw(ctx, w, h);
      ctx.restore();
      // bleed the edges into the padding so mip levels do not pick up neighbours
      ctx.drawImage(c, px, py, w, 1, px, py - pad, w, pad);
      ctx.drawImage(c, px, py + h - 1, w, 1, px, py + h, w, pad);
      ctx.drawImage(c, px, py - pad, 1, h + pad * 2, px - pad, py - pad, pad, h + pad * 2);
      ctx.drawImage(c, px + w - 1, py - pad, 1, h + pad * 2, px + w, py - pad, pad, h + pad * 2);
      this.regions[name] = { u0: px / S, v0: 1 - (py + h) / S, u1: (px + w) / S, v1: 1 - py / S };
      x += w + pad * 2;
      rowH = Math.max(rowH, h + pad * 2);
    }
    this.pending.length = 0;
  }
}

function grime(ctx: Ctx, w: number, h: number, rng: Rng, amount = 1): void {
  for (let k = 0; k < 14 * amount; k++) {
    const x = rng() * w, y = rng() * h, r = (0.08 + rng() * 0.25) * Math.min(w, h);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dark = rng() < 0.75;
    g.addColorStop(0, dark ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.05)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let k = 0; k < 6 * amount; k++) {
    const x = rng() * w;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.3 + rng() * 0.3, 'rgba(0,0,0,0.14)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 1 + rng() * 3, h);
  }
}

function label(ctx: Ctx, text: string, x: number, y: number, px: number, color: string, align: CanvasTextAlign = 'center', weight = '700', family = '"Helvetica Neue", Arial, sans-serif', maxW?: number): void {
  ctx.font = `${weight} ${px}px ${family}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, x, y, maxW);
}

function scribble(ctx: Ctx, w: number, h: number, rng: Rng, color: string, lw: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let x = w * 0.08, y = h * (0.3 + rng() * 0.4);
  ctx.moveTo(x, y);
  const n = 6 + Math.floor(rng() * 5);
  for (let i = 0; i < n; i++) {
    const nx = x + (w * 0.84) / n;
    ctx.bezierCurveTo(x + (rng() - 0.3) * w * 0.2, h * rng(), nx - rng() * w * 0.12, h * rng(), nx, h * (0.2 + rng() * 0.6));
    x = nx;
  }
  ctx.stroke();
}

function drawWindowFrame(ctx: Ctx, w: number, h: number, frame: string, rail = true): void {
  ctx.strokeStyle = frame;
  ctx.lineWidth = 14;
  ctx.strokeRect(0, 0, w, h);
  if (rail) {
    ctx.fillStyle = frame;
    ctx.fillRect(0, h * 0.5 - 4, w, 8);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(7, 7, w - 14, h - 14);
}

function buildAtlas(rng: Rng): Atlas {
  const A = new Atlas();

  A.add('white', 40, 40, (ctx, w, h) => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  });

  /* ---- tall things first: packs better ---- */

  // raw plywood hoarding panel (1.2 x 2.4 m)
  // 0 plain, 1 torn poster, 2 stencilled
  for (let v = 0; v < 3; v++) {
    A.add('ply' + v, 256, 512, (ctx, w, h) => {
      ctx.fillStyle = v === 1 ? '#8a7450' : '#94794f';
      ctx.fillRect(0, 0, w, h);
      for (let k = 0; k < 70; k++) {
        ctx.strokeStyle = rgba(60, 42, 20, 0.05 + rng() * 0.14);
        ctx.lineWidth = 0.6 + rng() * 1.6;
        ctx.beginPath();
        const x = rng() * w;
        ctx.moveTo(x, 0);
        ctx.bezierCurveTo(x + (rng() - 0.5) * 30, h * 0.3, x + (rng() - 0.5) * 30, h * 0.7, x + (rng() - 0.5) * 16, h);
        ctx.stroke();
      }
      for (let k = 0; k < 4; k++) {
        ctx.fillStyle = 'rgba(50,34,16,0.5)';
        ctx.beginPath();
        ctx.ellipse(rng() * w, rng() * h, 3 + rng() * 4, 6 + rng() * 8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      grime(ctx, w, h, rng, 2);
      ctx.save();
      ctx.globalAlpha = 0.62;
      if (v === 2) {
        label(ctx, 'POST NO BILLS', w / 2, h * 0.36, 24, '#1c1a16', 'center', '700', '"Arial Narrow", Arial, sans-serif', w - 40);
      } else if (v === 1) {
        // torn poster remains
        ctx.fillStyle = '#857f70';
        ctx.fillRect(40, 120, 130, 170);
        ctx.fillStyle = '#3c3f46';
        ctx.fillRect(48, 130, 114, 70);
        ctx.fillStyle = '#6a2f28';
        ctx.fillRect(48, 210, 80, 12);
        ctx.fillStyle = '#8a7450';
        ctx.beginPath();
        ctx.moveTo(30, 250);
        ctx.lineTo(100, 228);
        ctx.lineTo(180, 262);
        ctx.lineTo(180, 300);
        ctx.lineTo(30, 300);
        ctx.fill();
      }
      ctx.restore();
      // dark base (splash) and panel edge
      const g = ctx.createLinearGradient(0, h * 0.8, 0, h);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.5)');
      ctx.fillStyle = g;
      ctx.fillRect(0, h * 0.8, w, h * 0.2);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, 2, h);
      ctx.fillRect(w - 2, 0, 2, h);
    });
  }

  // her front door (leaf only)
  A.add('door_home', 176, 336, (ctx, w, h) => {
    ctx.fillStyle = '#2a1c14';
    ctx.fillRect(0, 0, w, h);
    for (let k = 0; k < 40; k++) {
      ctx.fillStyle = rgba(0, 0, 0, 0.04 + rng() * 0.08);
      ctx.fillRect(rng() * w, 0, 1 + rng() * 2, h);
    }
    // glazed upper panel with the hallway light behind it
    const g = ctx.createLinearGradient(0, 30, 0, 190);
    g.addColorStop(0, '#b98a48');
    g.addColorStop(1, '#6e4f28');
    ctx.fillStyle = g;
    ctx.fillRect(30, 30, w - 60, 160);
    ctx.strokeStyle = '#1a110b';
    ctx.lineWidth = 5;
    ctx.strokeRect(30, 30, w - 60, 160);
    ctx.beginPath();
    ctx.moveTo(w / 2, 30);
    ctx.lineTo(w / 2, 190);
    ctx.stroke();
    // lace curtain texture on the glass
    for (let y = 36; y < 186; y += 5) {
      ctx.fillStyle = rgba(255, 240, 200, 0.05 + (y % 10 ? 0.03 : 0));
      ctx.fillRect(33, y, w - 66, 2);
    }
    // lower panels
    ctx.strokeStyle = '#150d08';
    ctx.lineWidth = 4;
    ctx.strokeRect(30, 212, w - 60, 86);
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(34, 216, w - 68, 78);
    // kick plate, handle, lock
    ctx.fillStyle = '#6d5a34';
    ctx.fillRect(10, h - 28, w - 20, 20);
    ctx.fillStyle = '#9c8246';
    ctx.fillRect(w - 26, 196, 10, 26);
    ctx.beginPath();
    ctx.arc(w - 21, 182, 4, 0, Math.PI * 2);
    ctx.fill();
    grime(ctx, w, h, rng, 1);
  });

  // generic tenement doors
  const doorCols = ['#1d2b25', '#34191a', '#1b1714', '#232a33'];
  for (let v = 0; v < 4; v++) {
    A.add('door' + v, 128, 272, (ctx, w, h) => {
      ctx.fillStyle = doorCols[v];
      ctx.fillRect(0, 0, w, h);
      // transom
      ctx.fillStyle = v === 1 ? '#3d2f18' : '#0a0d11';
      ctx.fillRect(10, 8, w - 20, 34);
      ctx.fillStyle = 'rgba(190,170,120,0.55)';
      label(ctx, String(120 + Math.floor(rng() * 180)), w / 2, 26, 19, 'rgba(200,180,130,0.6)', 'center', '600', 'Georgia, serif');
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 46, w, 5);
      // glass
      ctx.fillStyle = v === 1 ? '#4a3a1e' : '#090c10';
      if (v === 3) {
        ctx.fillRect(40, 70, w - 80, 90);
      } else {
        ctx.fillRect(18, 66, w - 36, 96);
        ctx.fillStyle = doorCols[v];
        ctx.fillRect(w / 2 - 3, 66, 6, 96);
      }
      // wire glass / reflection
      ctx.fillStyle = 'rgba(120,150,170,0.08)';
      ctx.beginPath();
      ctx.moveTo(20, 150);
      ctx.lineTo(60, 68);
      ctx.lineTo(80, 68);
      ctx.lineTo(40, 150);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 3;
      ctx.strokeRect(18, 176, w - 36, 72);
      ctx.fillStyle = '#7d6a3c';
      ctx.fillRect(w - 22, 160, 8, 18);
      ctx.fillStyle = '#4d4a44';
      ctx.fillRect(8, h - 20, w - 16, 14);
      grime(ctx, w, h, rng, 1.5);
      if (v === 3) scribble(ctx, w, 60, rng, 'rgba(200,200,190,0.35)', 2);
    });
  }

  // roll-down shutters
  for (let v = 0; v < 2; v++) {
    A.add('shutter' + v, 256, 256, (ctx, w, h) => {
      for (let y = 0; y < h; y += 8) {
        ctx.fillStyle = '#5b5e60';
        ctx.fillRect(0, y, w, 8);
        ctx.fillStyle = '#74777a';
        ctx.fillRect(0, y, w, 2);
        ctx.fillStyle = '#2d2f31';
        ctx.fillRect(0, y + 6, w, 2);
      }
      grime(ctx, w, h, rng, 3);
      ctx.save();
      ctx.translate(10, 60 + v * 40);
      scribble(ctx, 200, 110, rng, v ? 'rgba(206,206,196,0.6)' : 'rgba(40,40,46,0.8)', 7);
      ctx.translate(40, 60 - v * 90);
      scribble(ctx, 170, 80, rng, v ? 'rgba(120,60,50,0.7)' : 'rgba(150,170,190,0.55)', 5);
      ctx.restore();
      const g = ctx.createLinearGradient(0, h * 0.75, 0, h);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#2a2b2c';
      ctx.fillRect(w / 2 - 12, h - 20, 24, 14);
    });
  }

  // shop fridge door (lit)
  A.add('fridge', 200, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#dcebee');
    g.addColorStop(1, '#a9c2c8');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const cols = ['#8f4a40', '#b39a55', '#48634f', '#465a78', '#cfc9ba', '#6e4a34', '#a8704a', '#2a2a2a'];
    for (let r = 0; r < 5; r++) {
      const y = 14 + r * 48;
      ctx.fillStyle = 'rgba(40,60,70,0.55)';
      ctx.fillRect(8, y + 40, w - 16, 4);
      let x = 14;
      while (x < w - 22) {
        const bw = 9 + rng() * 5;
        ctx.fillStyle = cols[Math.floor(rng() * cols.length)];
        ctx.fillRect(x, y + 6 + rng() * 5, bw, 34);
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.fillRect(x + 1, y + 10, 2, 24);
        x += bw + 2;
      }
    }
    ctx.strokeStyle = '#1b1f22';
    ctx.lineWidth = 10;
    ctx.strokeRect(0, 0, w, h);
    ctx.fillStyle = '#3a4044';
    ctx.fillRect(w - 20, h * 0.35, 6, h * 0.3);
  });

  // ATM (lit screen)
  A.add('atm', 128, 256, (ctx, w, h) => {
    ctx.fillStyle = '#23272c';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#1b4f9c';
    ctx.fillRect(0, 0, w, 44);
    label(ctx, 'ATM', w / 2, 23, 28, '#e8eef6');
    const g = ctx.createLinearGradient(0, 60, 0, 130);
    g.addColorStop(0, '#9fd0ff');
    g.addColorStop(1, '#3f86d8');
    ctx.fillStyle = g;
    ctx.fillRect(22, 60, w - 44, 70);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (let k = 0; k < 4; k++) ctx.fillRect(30, 70 + k * 13, 40 + rng() * 30, 4);
    ctx.fillStyle = '#0c0d0f';
    ctx.fillRect(26, 148, w - 52, 8);
    ctx.fillStyle = '#51565c';
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) ctx.fillRect(36 + c * 20, 168 + r * 14, 14, 9);
    ctx.fillStyle = '#3fd06a';
    ctx.fillRect(w - 30, 150, 5, 4);
  });

  // 14 windows: 6 dark, 8 lit
  const frames = ['#1a1c1f', '#2d2c28', '#17191b', '#33312c', '#1e2226', '#24221f'];
  for (let v = 0; v < 6; v++) {
    A.add('win_d' + v, 128, 208, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#0d1319');
      g.addColorStop(1, '#06080b');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      if (v === 1 || v === 4) {
        // closed blinds
        for (let y = 8; y < (v === 1 ? h : h * 0.55); y += 5) {
          ctx.fillStyle = rgba(46, 48, 50, 0.9);
          ctx.fillRect(8, y, w - 16, 3);
        }
      }
      if (v === 2) {
        // drawn curtains with a gap
        ctx.fillStyle = '#1c1d22';
        ctx.fillRect(8, 8, w * 0.38, h - 16);
        ctx.fillRect(w * 0.6, 8, w * 0.4 - 8, h - 16);
        for (let x = 12; x < w * 0.4; x += 7) {
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.fillRect(x, 8, 2, h - 16);
          ctx.fillRect(w - x, 8, 2, h - 16);
        }
      }
      if (v === 5) {
        // window guard
        ctx.strokeStyle = '#22262a';
        ctx.lineWidth = 3;
        for (let y = h * 0.58; y < h - 10; y += 14) {
          ctx.beginPath();
          ctx.moveTo(8, y);
          ctx.lineTo(w - 8, y);
          ctx.stroke();
        }
      }
      // faint sky reflection
      ctx.fillStyle = 'rgba(110,140,165,0.07)';
      ctx.beginPath();
      ctx.moveTo(w * 0.1, h * 0.46);
      ctx.lineTo(w * 0.55, 8);
      ctx.lineTo(w * 0.85, 8);
      ctx.lineTo(w * 0.4, h * 0.46);
      ctx.fill();
      drawWindowFrame(ctx, w, h, frames[v]);
      grime(ctx, w, h, rng, 0.6);
    });
  }
  for (let v = 0; v < 8; v++) {
    A.add('win_l' + v, 128, 208, (ctx, w, h) => {
      const base = [
        ['#d9a253', '#b47a34'], // warm curtain
        ['#d7ab66', '#bb8a45'], // blinds
        ['#e6c078', '#a7722f'], // lamp behind sheer
        ['#1a2634', '#31506c'], // tv
        ['#c3ccb0', '#98a488'], // kitchen fluorescent
        ['#dba75a', '#b0762f'], // figure
        ['#c79a58', '#8f6a3a'], // half shade
        ['#93392a', '#5e2219'], // red curtain
      ][v];
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, base[0]);
      g.addColorStop(1, base[1]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      if (v === 0 || v === 7 || v === 5) {
        for (let x = 8; x < w - 8; x += 9) {
          ctx.fillStyle = `rgba(0,0,0,${0.06 + rng() * 0.1})`;
          ctx.fillRect(x, 8, 3, h - 16);
          ctx.fillStyle = 'rgba(255,240,200,0.07)';
          ctx.fillRect(x + 4, 8, 2, h - 16);
        }
      }
      if (v === 1) {
        for (let y = 8; y < h - 8; y += 6) {
          ctx.fillStyle = 'rgba(60,36,10,0.5)';
          ctx.fillRect(8, y, w - 16, 2);
        }
      }
      if (v === 2) {
        const rg = ctx.createRadialGradient(w * 0.62, h * 0.66, 2, w * 0.62, h * 0.66, 70);
        rg.addColorStop(0, 'rgba(255,236,190,0.95)');
        rg.addColorStop(1, 'rgba(255,236,190,0)');
        ctx.fillStyle = rg;
        ctx.fillRect(0, 0, w, h);
      }
      if (v === 3) {
        const rg = ctx.createRadialGradient(w * 0.4, h * 0.8, 2, w * 0.4, h * 0.8, 90);
        rg.addColorStop(0, 'rgba(120,170,220,0.8)');
        rg.addColorStop(1, 'rgba(120,170,220,0)');
        ctx.fillStyle = rg;
        ctx.fillRect(0, 0, w, h);
      }
      if (v === 4) {
        // things on the sill
        ctx.fillStyle = '#28302a';
        ctx.fillRect(22, h - 52, 12, 40);
        ctx.fillRect(40, h - 40, 16, 28);
        ctx.beginPath();
        ctx.ellipse(86, h - 46, 16, 22, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(80, h - 28, 12, 18);
      }
      if (v === 5) {
        // someone standing at the window
        ctx.fillStyle = 'rgba(28,20,14,0.9)';
        ctx.beginPath();
        ctx.ellipse(w * 0.6, h * 0.34, 13, 16, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(w * 0.36, h);
        ctx.quadraticCurveTo(w * 0.38, h * 0.47, w * 0.6, h * 0.45);
        ctx.quadraticCurveTo(w * 0.84, h * 0.47, w * 0.86, h);
        ctx.fill();
      }
      if (v === 6) {
        ctx.fillStyle = '#b08a4e';
        ctx.fillRect(8, 8, w - 16, h * 0.42);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(8, h * 0.42 + 6, w - 16, 3);
        ctx.fillStyle = '#5c452a';
        ctx.fillRect(w * 0.55, h * 0.56, 30, 24);
      }
      drawWindowFrame(ctx, w, h, '#17140f');
    });
  }

  // interior shelves (lit)
  A.add('shelves', 512, 256, (ctx, w, h) => {
    ctx.fillStyle = '#d9d2bf';
    ctx.fillRect(0, 0, w, h);
    const cols = ['#8f4a40', '#b39a55', '#48634f', '#465a78', '#cfc9ba', '#75563c', '#a8704a', '#544560', '#b08a90', '#5c8286'];
    for (let r = 0; r < 5; r++) {
      const y = r * 51;
      let x = 4;
      while (x < w - 12) {
        const bw = 10 + rng() * 22, bh = 26 + rng() * 16;
        ctx.fillStyle = cols[Math.floor(rng() * cols.length)];
        ctx.fillRect(x, y + 44 - bh, bw, bh);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(x + 2, y + 44 - bh + 4, bw - 4, 5);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(x + bw - 2, y + 44 - bh, 2, bh);
        x += bw + 1 + (rng() < 0.1 ? 10 : 0);
      }
      ctx.fillStyle = '#8f8a7c';
      ctx.fillRect(0, y + 44, w, 7);
      ctx.fillStyle = '#f2ead0';
      for (let x2 = 8; x2 < w; x2 += 34) ctx.fillRect(x2, y + 45, 14, 5);
    }
  });

  // awning face and valance
  A.add('awning', 1024, 150, (ctx, w, h) => {
    ctx.fillStyle = '#a8842e';
    ctx.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 64) {
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      ctx.fillRect(x, 0, 3, h);
    }
    ctx.fillStyle = '#6e1f18';
    ctx.fillRect(0, 0, w, 12);
    ctx.fillRect(0, h - 10, w, 10);
    label(ctx, 'DELI · GROCERY', w / 2, h / 2 + 4, 88, '#6e1f18', 'center', '800', 'Impact, "Arial Narrow", Arial, sans-serif', 620);
    label(ctx, 'OPEN', 96, h / 2 - 16, 34, '#27371f', 'center', '800');
    label(ctx, '24 HOURS', 96, h / 2 + 22, 30, '#27371f', 'center', '800');
    label(ctx, 'ATM', w - 100, h / 2 - 16, 36, '#27371f', 'center', '800');
    label(ctx, 'LOTTO', w - 100, h / 2 + 22, 30, '#27371f', 'center', '800');
    grime(ctx, w, h, rng, 4);
  });
  A.add('awning_val', 1024, 40, (ctx, w, h) => {
    ctx.fillStyle = '#9c7a2a';
    ctx.fillRect(0, 0, w, h);
    label(ctx, 'COFFEE   ·   SANDWICHES   ·   COLD BEER   ·   CIGARETTES   ·   ICE   ·   NEWSPAPERS', w / 2, h / 2 + 1, 22, '#5e1b15', 'center', '700', '"Helvetica Neue", Arial, sans-serif', w - 40);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, h - 4, w, 4);
  });

  A.add('sign_subway', 512, 96, (ctx, w, h) => {
    ctx.fillStyle = '#0d0e10';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e9e7e0';
    ctx.fillRect(0, 0, w, 5);
    label(ctx, 'Subway', 22, 38, 40, '#ecebe6', 'left', '700');
    label(ctx, 'Downtown & Brooklyn', 22, 74, 21, '#c9c8c2', 'left', '500');
    const bullets: Array<[string, string]> = [['#b23a2e', 'K'], ['#c9972a', 'V']];
    bullets.forEach(([col, ch], i) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(w - 110 + i * 62, 44, 25, 0, Math.PI * 2);
      ctx.fill();
      label(ctx, ch, w - 110 + i * 62, 46, 32, '#f3f1ea', 'center', '700');
    });
  });

  A.add('sign_laundro', 512, 96, (ctx, w, h) => {
    ctx.fillStyle = '#c9d2d6';
    ctx.fillRect(0, 0, w, h);
    label(ctx, 'LAUNDROMAT', w / 2 + 30, h / 2 + 2, 60, '#2c4d86', 'center', '800', '"Arial Narrow", Arial, sans-serif', 360);
    label(ctx, '24', 46, h / 2 - 6, 44, '#a3322a', 'center', '800');
    label(ctx, 'HR', 46, h / 2 + 28, 20, '#a3322a', 'center', '800');
    // a dead tube behind the left third
    const g = ctx.createLinearGradient(0, 0, w * 0.45, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.72)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    grime(ctx, w, h, rng, 2);
  });

  for (let v = 0; v < 2; v++) {
    A.add('sign_shop' + v, 512, 72, (ctx, w, h) => {
      ctx.fillStyle = v ? '#23201c' : '#1d2523';
      ctx.fillRect(0, 0, w, h);
      label(ctx, v ? 'HARDWARE  ·  LOCKSMITH' : 'TAILOR  ·  ALTERATIONS', w / 2, h / 2 + 2, 40, v ? '#8a7c58' : '#8c8a80', 'center', '700', 'Georgia, serif', w - 50);
      grime(ctx, w, h, rng, 3);
    });
  }

  A.add('ply_green', 256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#1f3a2d';
    ctx.fillRect(0, 0, w, h);
    for (let k = 0; k < 30; k++) {
      ctx.fillStyle = rgba(0, 0, 0, 0.05 + rng() * 0.08);
      ctx.fillRect(rng() * w, 0, 1 + rng() * 3, h);
    }
    grime(ctx, w, h, rng, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, 2, h);
    ctx.fillRect(w - 2, 0, 2, h);
    ctx.fillRect(0, h - 3, w, 3);
  });

  A.add('poster_wall', 256, 256, (ctx, w, h) => {
    const cols = ['#b7b1a0', '#6f2a22', '#2a3a4c', '#9a8a4a', '#30302e', '#8a8f92'];
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 3; c++) {
        const x = 6 + c * 83, y = 8 + r * 124;
        ctx.save();
        ctx.translate(x + 38, y + 56);
        ctx.rotate((rng() - 0.5) * 0.06);
        ctx.fillStyle = cols[Math.floor(rng() * cols.length)];
        ctx.fillRect(-38, -56, 76, 112);
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(-30, -46, 60, 40 + rng() * 20);
        ctx.fillStyle = 'rgba(240,235,220,0.7)';
        for (let k = 0; k < 3; k++) ctx.fillRect(-30, 22 + k * 10, 30 + rng() * 30, 5);
        ctx.restore();
      }
    }
    // tears
    ctx.globalCompositeOperation = 'destination-out';
    for (let k = 0; k < 9; k++) {
      ctx.beginPath();
      const x = rng() * w, y = rng() * h;
      ctx.moveTo(x, y);
      ctx.lineTo(x + 30 + rng() * 40, y + (rng() - 0.5) * 30);
      ctx.lineTo(x + 10 + rng() * 30, y + 20 + rng() * 40);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  });

  A.add('neon_open', 256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#08080a';
    ctx.fillRect(0, 0, w, h);
    ctx.shadowBlur = 16;
    ctx.shadowColor = '#3b6cff';
    ctx.strokeStyle = '#9db8ff';
    ctx.lineWidth = 5;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(16, 14, w - 32, h - 28, 26);
    else ctx.rect(16, 14, w - 32, h - 28);
    ctx.stroke();
    ctx.stroke();
    ctx.shadowColor = '#ff3a2a';
    ctx.shadowBlur = 18;
    ctx.font = '700 58px "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#ffb3a6';
    ctx.lineWidth = 4;
    ctx.strokeText('OPEN', w / 2, h / 2 + 3);
    ctx.strokeText('OPEN', w / 2, h / 2 + 3);
    ctx.shadowBlur = 0;
  });

  A.add('cigs', 256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#2a2622';
    ctx.fillRect(0, 0, w, h);
    const cols = ['#bdb7a9', '#8a443c', '#43577a', '#48634f', '#a8915a', '#262626'];
    for (let r = 0; r < 5; r++) {
      for (let x = 4; x < w - 8; x += 13) {
        ctx.fillStyle = cols[Math.floor(rng() * cols.length)];
        ctx.fillRect(x, 4 + r * 25, 11, 19);
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.fillRect(x, 4 + r * 25, 11, 5);
      }
    }
  });

  A.add('counter', 256, 96, (ctx, w, h) => {
    ctx.fillStyle = '#7a5c3a';
    ctx.fillRect(0, 0, w, h);
    for (let k = 0; k < 30; k++) {
      ctx.fillStyle = rgba(40, 24, 8, 0.08 + rng() * 0.1);
      ctx.fillRect(0, rng() * h, w, 1 + rng() * 2);
    }
    const cols = ['#8f4a40', '#b39a55', '#48634f', '#465a78', '#cfc9ba', '#a8704a'];
    for (let r = 0; r < 2; r++) {
      for (let x = 10; x < w - 14; x += 12) {
        ctx.fillStyle = cols[Math.floor(rng() * cols.length)];
        ctx.fillRect(x, 10 + r * 26, 10, 16);
      }
      ctx.fillStyle = '#3a3a3a';
      ctx.fillRect(6, 27 + r * 26, w - 12, 3);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, h - 10, w, 10);
  });

  A.add('ice', 256, 160, (ctx, w, h) => {
    ctx.fillStyle = '#c6cbcc';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#8b9092';
    ctx.lineWidth = 4;
    ctx.strokeRect(8, 8, w / 2 - 12, h - 16);
    ctx.strokeRect(w / 2 + 4, 8, w / 2 - 12, h - 16);
    label(ctx, 'ICE', w / 2, h / 2 + 4, 76, '#2b5a9c', 'center', '800', 'Impact, Arial, sans-serif');
    grime(ctx, w, h, rng, 3);
  });

  A.add('sign_oneway', 256, 80, (ctx, w, h) => {
    ctx.fillStyle = '#0c0c0d';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#d9d8d2';
    ctx.beginPath();
    ctx.moveTo(14, h / 2);
    ctx.lineTo(60, 12);
    ctx.lineTo(60, 26);
    ctx.lineTo(w - 14, 26);
    ctx.lineTo(w - 14, h - 26);
    ctx.lineTo(60, h - 26);
    ctx.lineTo(60, h - 12);
    ctx.fill();
    label(ctx, 'ONE WAY', w / 2 + 22, h / 2 + 2, 26, '#0c0c0d', 'center', '800');
  });
  (['ALDER ST', 'HOLLIS AV'] as const).forEach((name, i) => {
    A.add('sign_street' + i, 256, 56, (ctx, w, h) => {
      ctx.fillStyle = '#1c5136';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#cfd4cc';
      ctx.lineWidth = 3;
      ctx.strokeRect(3, 3, w - 6, h - 6);
      label(ctx, name, w / 2, h / 2 + 2, 32, '#e4e6de', 'center', '700');
    });
  });
  A.add('sign_parking', 96, 128, (ctx, w, h) => {
    ctx.fillStyle = '#d2d0c8';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#9a2b22';
    ctx.fillRect(6, 6, w - 12, 44);
    label(ctx, 'NO', w / 2, 20, 18, '#e6e2d8');
    label(ctx, 'PARKING', w / 2, 38, 15, '#e6e2d8');
    label(ctx, 'TUES & FRI', w / 2, 66, 13, '#9a2b22');
    label(ctx, '8AM-9:30AM', w / 2, 84, 12, '#9a2b22');
    ctx.fillStyle = '#9a2b22';
    ctx.fillRect(18, 104, 60, 6);
    grime(ctx, w, h, rng, 1);
  });

  A.add('intercom', 64, 128, (ctx, w, h) => {
    ctx.fillStyle = '#7b7d7c';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#3a3b3b';
    ctx.lineWidth = 3;
    ctx.strokeRect(1, 1, w - 2, h - 2);
    ctx.fillStyle = '#1b1c1c';
    for (let y = 12; y < 36; y += 5) ctx.fillRect(12, y, w - 24, 2);
    for (let r = 0; r < 6; r++) {
      ctx.fillStyle = '#2a2b2b';
      ctx.fillRect(10, 46 + r * 12, 12, 8);
      ctx.fillStyle = '#d5d1c2';
      ctx.fillRect(26, 47 + r * 12, 28, 6);
    }
    ctx.fillStyle = '#d83a2a';
    ctx.fillRect(w - 14, 120, 5, 4);
  });

  A.add('transom_home', 176, 64, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#c2924e');
    g.addColorStop(1, '#8f6a34');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    label(ctx, '214', w / 2, h / 2 + 3, 40, '#2a1a0c', 'center', '700', 'Georgia, serif');
    ctx.strokeStyle = '#1a110b';
    ctx.lineWidth = 8;
    ctx.strokeRect(0, 0, w, h);
  });

  A.add('tile', 128, 128, (ctx, w, h) => {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const l = 176 + rng() * 22 - ((r + c) % 2 ? 26 : 0);
        ctx.fillStyle = rgba(l, l * 0.97, l * 0.88);
        ctx.fillRect(c * 32, r * 32, 32, 32);
      }
    }
    ctx.fillStyle = 'rgba(40,36,30,0.7)';
    for (let k = 0; k <= 4; k++) {
      ctx.fillRect(k * 32 - 1, 0, 2, h);
      ctx.fillRect(0, k * 32 - 1, w, 2);
    }
    grime(ctx, w, h, rng, 1);
  });

  A.add('subway_tile', 128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#b9bcb4';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(40,44,40,0.55)';
    for (let r = 0; r <= 8; r++) ctx.fillRect(0, r * 16 - 1, w, 2);
    for (let r = 0; r < 8; r++) for (let c = 0; c <= 4; c++) ctx.fillRect(c * 32 + (r % 2 ? 16 : 0) - 1, r * 16, 2, 16);
    ctx.fillStyle = '#2d5a45';
    ctx.fillRect(0, 16, w, 14);
    grime(ctx, w, h, rng, 3);
  });

  A.add('grate', 128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#060606';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#34373a';
    for (let x = 0; x < w; x += 6) ctx.fillRect(x, 0, 2.4, h);
    ctx.fillStyle = '#2a2d30';
    for (let y = 0; y < h; y += 32) ctx.fillRect(0, y, w, 4);
    ctx.strokeStyle = '#3d4043';
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, w, h);
  });

  A.add('plate', 128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#45474a';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(160,165,170,0.28)';
    ctx.lineWidth = 2;
    for (let y = 0; y < h; y += 12) {
      for (let x = (y / 12) % 2 ? 6 : 0; x < w; x += 12) {
        ctx.beginPath();
        if (((x + y) / 6) % 2 < 1) {
          ctx.moveTo(x + 2, y + 2);
          ctx.lineTo(x + 8, y + 8);
        } else {
          ctx.moveTo(x + 8, y + 2);
          ctx.lineTo(x + 2, y + 8);
        }
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#17181a';
    ctx.fillRect(w / 2 - 1.5, 0, 3, h);
    ctx.strokeStyle = '#1e1f21';
    ctx.lineWidth = 5;
    ctx.strokeRect(0, 0, w, h);
    grime(ctx, w, h, rng, 2);
    ctx.fillStyle = 'rgba(110,60,30,0.25)';
    ctx.fillRect(0, h - 26, w, 26);
  });

  A.add('chain', 128, 128, (ctx, w, h) => {
    ctx.strokeStyle = '#7d848a';
    ctx.lineWidth = 2.6;
    for (let k = -h; k < w + h; k += 16) {
      ctx.beginPath();
      ctx.moveTo(k, 0);
      ctx.lineTo(k + h, h);
      ctx.moveTo(k + h, 0);
      ctx.lineTo(k, h);
      ctx.stroke();
    }
  });

  A.add('manhole', 128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#17181a';
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 62, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3a3c3f';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 58, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#2c2e31';
    for (const r of [44, 30, 14]) {
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let a = 0; a < 12; a++) {
      ctx.beginPath();
      ctx.moveTo(w / 2 + Math.cos(a * 0.5236) * 14, h / 2 + Math.sin(a * 0.5236) * 14);
      ctx.lineTo(w / 2 + Math.cos(a * 0.5236) * 44, h / 2 + Math.sin(a * 0.5236) * 44);
      ctx.stroke();
    }
  });

  A.add('xwalk', 64, 256, (ctx, w, h) => {
    ctx.fillStyle = '#b9b8b0';
    ctx.fillRect(4, 0, w - 8, h);
    ctx.globalCompositeOperation = 'destination-out';
    for (let k = 0; k < 90; k++) {
      ctx.fillStyle = rgba(0, 0, 0, 0.25 + rng() * 0.6);
      ctx.beginPath();
      ctx.ellipse(rng() * w, rng() * h, 2 + rng() * 9, 2 + rng() * 14, rng() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  });

  for (let v = 0; v < 2; v++) {
    A.add('stain' + v, 128, 128, (ctx, w, h) => {
      for (let k = 0; k < 7; k++) {
        const x = 34 + rng() * 60, y = 34 + rng() * 60, r = 14 + rng() * 24;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, v ? 'rgba(4,4,6,0.6)' : 'rgba(6,6,8,0.42)');
        g.addColorStop(1, 'rgba(4,4,6,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
    });
  }
  // soft-edged dark blob used for contact shadows
  A.add('blob', 96, 96, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = Math.max(0, Math.abs(x - w / 2 + 0.5) / (w / 2) - 0.45) / 0.55;
        const dy = Math.max(0, Math.abs(y - h / 2 + 0.5) / (h / 2) - 0.45) / 0.55;
        const f = Math.max(0, 1 - Math.hypot(dx, dy));
        img.data[(y * w + x) * 4 + 3] = f * f * (3 - 2 * f) * 255;
      }
    }
    // putImageData ignores the transform, so draw through a scratch canvas
    const [sc, sctx] = canvasOf(w, h);
    sctx.putImageData(img, 0, 0);
    ctx.drawImage(sc, 0, 0);
  });

  // even, soft-edged shade (the gloom under the sidewalk shed)
  A.add('shade', 64, 64, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = Math.max(0, Math.abs(x - w / 2 + 0.5) / (w / 2) - 0.7) / 0.3;
        const dy = Math.max(0, Math.abs(y - h / 2 + 0.5) / (h / 2) - 0.8) / 0.2;
        const f = Math.max(0, 1 - Math.hypot(dx, dy));
        img.data[(y * w + x) * 4 + 3] = f * f * (3 - 2 * f) * 150;
      }
    }
    const [sc, sctx] = canvasOf(w, h);
    sctx.putImageData(img, 0, 0);
    ctx.drawImage(sc, 0, 0);
  });

  for (let v = 0; v < 3; v++) {
    A.add('tag' + v, 256, 128, (ctx, w, h) => {
      const cols = ['rgba(196,196,186,0.75)', 'rgba(120,150,176,0.7)', 'rgba(150,62,50,0.75)'];
      scribble(ctx, w, h, rng, cols[v], 7);
      ctx.save();
      ctx.translate(30, 20);
      scribble(ctx, w * 0.6, h * 0.6, rng, cols[(v + 1) % 3], 4);
      ctx.restore();
    });
  }

  A.add('permit', 96, 128, (ctx, w, h) => {
    ctx.fillStyle = '#c9c6b8';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#2d2d2d';
    ctx.fillRect(8, 8, w - 16, 16);
    for (let k = 0; k < 8; k++) ctx.fillRect(8, 34 + k * 10, 30 + rng() * 48, 3);
    ctx.fillStyle = '#9a2b22';
    ctx.fillRect(8, 114, 40, 6);
  });

  for (let v = 0; v < 3; v++) {
    A.add('poster' + v, 96, 128, (ctx, w, h) => {
      ctx.fillStyle = ['#8f8450', '#7a4038', '#3f5270'][v];
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(245,240,225,0.85)';
      ctx.fillRect(10, 12, w - 20, 26);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.ellipse(w / 2, 78, 16, 26, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(245,240,225,0.8)';
      ctx.fillRect(14, 112, w - 28, 8);
    });
  }

  A.add('plate_car', 64, 32, (ctx, w, h) => {
    ctx.fillStyle = '#b9b08a';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#20263a';
    for (let k = 0; k < 6; k++) ctx.fillRect(7 + k * 9, 10, 6, 14);
    ctx.fillRect(0, 0, w, 4);
  });

  A.finish();
  return A;
}

/* ----------------------------------------------------------------- export */

export interface StreetTextures {
  atlas: THREE.CanvasTexture;
  regions: Record<string, UVRect>;
  brick: THREE.CanvasTexture;
  asphalt: THREE.CanvasTexture;
  asphaltRough: THREE.CanvasTexture;
  asphaltNormal: THREE.CanvasTexture;
  sidewalk: THREE.CanvasTexture;
  glow: THREE.CanvasTexture;
  skyline: THREE.CanvasTexture;
  /** equirectangular; run it through PMREMGenerator before use */
  env: THREE.CanvasTexture;
  dispose(): void;
}

export function createTextures(maxAnisotropy: number): StreetTextures {
  const rng = mulberry32(0x51de3);
  const aniso = Math.min(8, Math.max(1, maxAnisotropy));
  const A = buildAtlas(rng);
  const atlas = tex(A.canvas, true, false, aniso);
  const brick = brickTexture(rng, aniso);
  const asph = asphaltTextures(rng, aniso);
  const sidewalk = sidewalkTexture(rng, aniso);
  const glow = glowTexture();
  const skyline = skylineTexture(rng);
  const env = envTexture(rng);
  const all = [atlas, brick, asph.map, asph.rough, asph.normal, sidewalk, glow, skyline, env];
  return {
    atlas,
    regions: A.regions,
    brick,
    asphalt: asph.map,
    asphaltRough: asph.rough,
    asphaltNormal: asph.normal,
    sidewalk,
    glow,
    skyline,
    env,
    dispose() {
      for (const t of all) t.dispose();
    },
  };
}
