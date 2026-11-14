/**
 * Cheap atmosphere: additive glows (lamp halos and light pools on the ground),
 * the sky dome, the distant skyline, manhole steam.
 */

import * as THREE from 'three';

const _c = new THREE.Color();

/**
 * One draw call for every halo and ground light-pool in the street.
 * Billboards face the camera (corner offsets applied in view space);
 * flat quads carry real world positions and zero corner offsets.
 */
export class GlowSystem {
  private pos: number[] = [];
  private corner: number[] = [];
  private col: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];
  private base: number[] = []; // per quad: r,g,b (linear, pre-multiplied by intensity)
  private count = 0;
  private colAttr: THREE.BufferAttribute | null = null;
  private posAttr: THREE.BufferAttribute | null = null;
  mesh: THREE.Mesh | null = null;
  material: THREE.ShaderMaterial | null = null;

  private pushQuad(p: number[], corners: number[], hex: number, intensity: number): number {
    _c.setHex(hex);
    const r = _c.r * intensity, g = _c.g * intensity, b = _c.b * intensity;
    const v = this.count * 4;
    this.pos.push(...p);
    this.corner.push(...corners);
    for (let i = 0; i < 4; i++) this.col.push(r, g, b);
    this.uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    this.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    this.base.push(r, g, b);
    return this.count++;
  }

  /** Camera-facing halo. size = diameter in metres; bias pulls it toward the camera so the fixture does not clip it. */
  billboard(x: number, y: number, z: number, size: number, hex: number, intensity: number, bias = 0.35): number {
    const h = size / 2;
    return this.pushQuad([x, y, z, x, y, z, x, y, z, x, y, z], [-h, -h, bias, h, -h, bias, h, h, bias, -h, h, bias], hex, intensity);
  }

  /** Horizontal pool of light on the ground, centred at (x, z). */
  flat(x: number, y: number, z: number, sx: number, sz: number, hex: number, intensity: number): number {
    const hx = sx / 2, hz = sz / 2;
    return this.pushQuad(
      [x - hx, y, z + hz, x + hx, y, z + hz, x + hx, y, z - hz, x - hx, y, z - hz],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hex,
      intensity,
    );
  }

  /** Arbitrary world-space quad (a,b,c,d counter-clockwise), e.g. window light spilling across the sidewalk. */
  quad(pts: number[], hex: number, intensity: number): number {
    return this.pushQuad(pts, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], hex, intensity);
  }

  /** Scale a quad's brightness relative to its base colour. */
  setLevel(id: number, k: number): void {
    if (!this.colAttr) return;
    const a = this.colAttr.array as Float32Array;
    const r = this.base[id * 3] * k, g = this.base[id * 3 + 1] * k, b = this.base[id * 3 + 2] * k;
    for (let i = 0; i < 4; i++) {
      a[(id * 4 + i) * 3] = r;
      a[(id * 4 + i) * 3 + 1] = g;
      a[(id * 4 + i) * 3 + 2] = b;
    }
    this.colAttr.needsUpdate = true;
  }

  /** Replace a quad's base colour. */
  setColor(id: number, hex: number, intensity: number): void {
    _c.setHex(hex);
    this.base[id * 3] = _c.r * intensity;
    this.base[id * 3 + 1] = _c.g * intensity;
    this.base[id * 3 + 2] = _c.b * intensity;
    this.setLevel(id, 1);
  }

  /** Move a billboard. */
  setPosition(id: number, x: number, y: number, z: number): void {
    if (!this.posAttr) return;
    const a = this.posAttr.array as Float32Array;
    for (let i = 0; i < 4; i++) {
      a[(id * 4 + i) * 3] = x;
      a[(id * 4 + i) * 3 + 1] = y;
      a[(id * 4 + i) * 3 + 2] = z;
    }
    this.posAttr.needsUpdate = true;
  }

  build(map: THREE.Texture, fogDensity: number): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(this.pos), 3);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(this.col), 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('corner', new THREE.BufferAttribute(new Float32Array(this.corner), 3));
    g.setAttribute('color', this.colAttr);
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setIndex(this.idx);
    this.material = new THREE.ShaderMaterial({
      name: 'Glow',
      uniforms: { map: { value: map }, uFog: { value: fogDensity } },
      vertexShader: /* glsl */ `
        attribute vec3 corner;
        attribute vec3 color;
        uniform float uFog;
        varying vec2 vUv;
        varying vec3 vColor;
        void main() {
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          float dist = length( mv.xyz );
          // halos hold their size a little in the haze instead of shrinking to nothing
          float grow = 1.0 + min( dist, 120.0 ) * 0.016 * step( 0.0001, abs( corner.x ) + abs( corner.y ) );
          mv.xyz -= normalize( mv.xyz ) * min( corner.z, dist * 0.5 );
          mv.xy += corner.xy * grow;
          gl_Position = projectionMatrix * mv;
          float f = uFog * dist;
          vColor = color * exp( - f * f * 0.55 );
          vUv = uv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying vec2 vUv;
        varying vec3 vColor;
        void main() {
          gl_FragColor = vec4( vColor * texture2D( map, vUv ).r, 1.0 );
        }
      `,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      transparent: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -6,
    });
    const mesh = new THREE.Mesh(g, this.material);
    mesh.name = 'glow';
    mesh.frustumCulled = false;
    mesh.renderOrder = 8;
    this.mesh = mesh;
    return mesh;
  }
}

/** Night sky: near-black overhead, murky city glow toward the horizon. */
export function createSky(fogColor: THREE.Color): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    name: 'Sky',
    uniforms: {
      uHorizon: { value: fogColor.clone() },
      uZenith: { value: new THREE.Color(0x03060a) },
      uGlow: { value: new THREE.Color(0x2b2a26) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize( position );
        vec4 p = projectionMatrix * viewMatrix * vec4( position + cameraPosition, 1.0 );
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uHorizon;
      uniform vec3 uZenith;
      uniform vec3 uGlow;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize( vDir );
        float h = max( d.y, 0.0 );
        vec3 col = mix( uHorizon, uZenith, pow( smoothstep( 0.0, 0.75, h ), 0.55 ) );
        // sodium haze low over the avenue ends (the street runs along Z)
        float along = pow( abs( d.z ), 3.0 );
        col += uGlow * ( 0.35 + 0.65 * along ) * exp( - h * 5.0 );
        // faint mottling so the dome is not a flat gradient
        float n = sin( d.x * 9.0 + d.z * 4.0 ) * sin( d.z * 7.0 - d.y * 11.0 );
        col *= 1.0 + 0.05 * n * smoothstep( 0.05, 0.4, h );
        gl_FragColor = vec4( col, 1.0 );
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), mat);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

/** A ring of far-off towers, visible down the street's axis above the cross-street roofs. */
export function createSkyline(map: THREE.Texture): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(212, 212, 96, 48, 1, true);
  map.repeat.set(3, 1);
  const mat = new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    depthWrite: false,
    fog: false,
    side: THREE.BackSide,
    color: new THREE.Color(1.05, 1.05, 1.05),
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'skyline';
  mesh.position.set(0, 48 - 22, -66);
  mesh.renderOrder = -9;
  mesh.frustumCulled = false;
  return mesh;
}

/** Steam rising from a manhole: a handful of soft billboards animated entirely in the vertex shader. */
export function createSteam(map: THREE.Texture, x: number, y: number, z: number, tint: THREE.Color, fogColor: THREE.Color, fogDensity: number): THREE.Mesh {
  const N = 18;
  const pos: number[] = [], corner: number[] = [], seed: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i < N; i++) {
    const s = i / N;
    const r = Math.sin(i * 12.9898) * 43758.5453;
    const rnd = r - Math.floor(r);
    for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(x, y, z);
      corner.push(cx, cy);
      seed.push(s, rnd);
    }
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('corner', new THREE.Float32BufferAttribute(corner, 2));
  g.setAttribute('seed', new THREE.Float32BufferAttribute(seed, 2));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    name: 'Steam',
    uniforms: {
      map: { value: map },
      uTime: { value: 0 },
      uTint: { value: tint },
      uFogColor: { value: fogColor },
      uFog: { value: fogDensity },
    },
    vertexShader: /* glsl */ `
      attribute vec2 corner;
      attribute vec2 seed;
      uniform float uTime;
      uniform float uFog;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vFog;
      void main() {
        float t = fract( uTime * 0.16 + seed.x + seed.y * 0.37 );
        vec3 p = position;
        float sway = sin( uTime * 0.7 + seed.y * 20.0 ) * 0.25;
        p.x += ( seed.y - 0.5 ) * 0.25 + ( 0.9 + sway ) * t * t;
        p.z += ( fract( seed.y * 7.0 ) - 0.5 ) * 0.25 - 0.5 * t * t;
        p.y += t * ( 3.6 + seed.y * 1.2 );
        float size = mix( 0.45, 2.8, pow( t, 0.8 ) );
        vec4 mv = modelViewMatrix * vec4( p, 1.0 );
        mv.xy += corner * size * 0.5;
        gl_Position = projectionMatrix * mv;
        vAlpha = smoothstep( 0.0, 0.12, t ) * ( 1.0 - smoothstep( 0.35, 1.0, t ) );
        float f = uFog * length( mv.xyz );
        vFog = 1.0 - exp( - f * f );
        vUv = uv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec3 uTint;
      uniform vec3 uFogColor;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vFog;
      void main() {
        float a = texture2D( map, vUv ).r;
        vec3 col = mix( uTint, uFogColor, vFog );
        gl_FragColor = vec4( col, a * vAlpha * 0.62 );
      }
    `,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'steam';
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;
  return mesh;
}
