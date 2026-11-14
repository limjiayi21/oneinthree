/**
 * Renderer, camera, render loop and the post-processing chain.
 *
 *   scene -> (MSAA, half-float) -> subtle bloom -> grade pass -> screen
 *
 * The grade pass does tone mapping + sRGB itself (so the chain needs no
 * separate OutputPass) and then, in display space: chromatic aberration,
 * mild desaturation, vignette and film grain. All of it scales with
 * setFear(); pulse() adds a short impulse on top.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { Engine } from '../contracts';

/** Extra, non-contract handles used by the dev harness. */
export interface EngineDebug extends Engine {
  /** Run subscribers and render exactly one frame (works in a background tab). */
  renderOnce(dt?: number): void;
  /** Draw calls / triangles of the last frame, including shadow and post passes. */
  readonly stats: { calls: number; sceneCalls: number; triangles: number; pixelRatio: number };
  readonly bloom: UnrealBloomPass;
}

const MAX_PIXEL_RATIO = 2;
/** Hard cap on shaded pixels per frame (about 2560 x 1330). Keeps hi-dpi laptops honest. */
const MAX_PIXELS = 3.4e6;

const GRADE_VERT = /* glsl */ `
  precision highp float;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  attribute vec3 position;
  attribute vec2 uv;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const GRADE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform vec2 uRes;
  uniform float uTime;
  uniform float uFear;   // 0..1, smoothed
  uniform float uPulse;  // 0..1, decays in ~0.4 s
  uniform float uBeat;   // 0..1 heartbeat envelope
  #include <tonemapping_pars_fragment>
  #include <colorspace_pars_fragment>
  varying vec2 vUv;

  float hash12( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }

  vec3 grade( vec3 hdr ) {
    vec3 c = ACESFilmicToneMapping( hdr );
    return sRGBTransferOETF( vec4( c, 1.0 ) ).rgb;
  }

  void main() {
    vec2 c = vUv - 0.5;
    float aspect = uRes.x / max( uRes.y, 1.0 );
    // distance from centre, corner ~= 1
    vec2 cv = c * vec2( mix( 1.0, aspect, 0.55 ), 1.0 );
    float r = length( cv ) * 1.42;

    // chromatic aberration: radial, grows toward the edge
    float ca = 0.0007 + 0.0026 * uFear + 0.0060 * uPulse + 0.0022 * uBeat * uFear;
    vec2 off = c * ca * ( 0.35 + 1.9 * r * r );
    vec3 hdr;
    hdr.r = texture2D( tDiffuse, vUv + off ).r;
    hdr.g = texture2D( tDiffuse, vUv ).g;
    hdr.b = texture2D( tDiffuse, vUv - off ).b;

    vec3 col = grade( hdr );

    // mild desaturation, more with fear
    float l = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
    col = mix( col, vec3( l ), clamp( 0.10 + 0.34 * uFear + 0.15 * uPulse, 0.0, 1.0 ) );
    // fear cools and flattens the picture slightly
    col *= mix( vec3( 1.0 ), vec3( 0.93, 0.98, 1.03 ), uFear );

    // vignette: tightens with fear, breathes with the heartbeat
    float inner = mix( 0.62, 0.38, uFear ) - 0.10 * uPulse - 0.035 * uBeat * uFear;
    float outer = mix( 1.38, 1.08, uFear ) - 0.16 * uPulse;
    float v = smoothstep( outer, inner, r );
    float strength = clamp( 0.50 + 0.28 * uFear + 0.30 * uPulse, 0.0, 0.95 );
    col *= mix( 1.0 - strength, 1.0, v );

    // startle flash: a brief lift in the centre of the frame
    col += uPulse * 0.07 * ( 1.0 - smoothstep( 0.0, 0.75, r ) );

    // film grain, stronger in the shadows
    float n = hash12( gl_FragCoord.xy + fract( uTime * 7.31 ) * vec2( 173.0, 291.0 ) ) - 0.5;
    float l2 = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
    col += n * ( 0.040 + 0.045 * uFear ) * ( 1.0 - 0.55 * smoothstep( 0.0, 0.8, l2 ) );

    gl_FragColor = vec4( max( col, 0.0 ), 1.0 );
  }
`;

class GradePass extends Pass {
  readonly uniforms = {
    tDiffuse: { value: null as THREE.Texture | null },
    toneMappingExposure: { value: 1 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uFear: { value: 0 },
    uPulse: { value: 0 },
    uBeat: { value: 0 },
  };
  readonly material: THREE.RawShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor() {
    super();
    this.material = new THREE.RawShaderMaterial({
      name: 'GradePass',
      uniforms: this.uniforms,
      vertexShader: GRADE_VERT,
      fragmentShader: GRADE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  override setSize(width: number, height: number): void {
    this.uniforms.uRes.value.set(width, height);
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}

export function createEngine(canvas: HTMLCanvasElement): Engine {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // MSAA happens on the composer target instead
    alpha: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;
  renderer.setClearColor(0x05080b, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 300);
  camera.rotation.order = 'YXZ';
  camera.position.set(0, 1.62, 0);
  // In the graph so first-person body parts can be parented to it.
  scene.add(camera);

  // An unstyled <canvas> is 300x150: make it fill the viewport unless the page already laid it out.
  const cs = getComputedStyle(canvas);
  if (cs.position === 'static' && canvas.clientWidth <= 300 && canvas.clientHeight <= 150) {
    Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', display: 'block' });
  }

  /* ---------------------------------------------------------- post chain */

  let quality = 1; // dynamic resolution scale, only ever lowered
  const sizeOf = () => {
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    let pr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    pr = Math.min(pr, Math.sqrt(MAX_PIXELS / (w * h)));
    pr = Math.max(0.5, pr * quality);
    return { w, h, pr };
  };

  const first = sizeOf();
  renderer.setPixelRatio(first.pr);
  renderer.setSize(first.w, first.h, false);

  const target = new THREE.WebGLRenderTarget(Math.round(first.w * first.pr), Math.round(first.h * first.pr), {
    type: THREE.HalfFloatType,
    samples: 4,
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(first.pr);
  composer.setSize(first.w, first.h);

  const renderPass = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(new THREE.Vector2(first.w, first.h), 0.42, 0.72, 1.0);
  const grade = new GradePass();
  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(grade);

  const stats = { calls: 0, sceneCalls: 0, triangles: 0, pixelRatio: first.pr };

  function resize(): void {
    const { w, h, pr } = sizeOf();
    stats.pixelRatio = pr;
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();

  const onWindowResize = () => resize();
  window.addEventListener('resize', onWindowResize);
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => resize());
    observer.observe(canvas);
  }

  /* --------------------------------------------------------- fear / pulse */

  let fearTarget = 0;
  let fear = 0;
  let pulse = 0;
  let beatPhase = 0;

  function updatePost(dt: number, elapsed: number): void {
    // ease toward the target: quick to rise, slower to settle
    const rate = fearTarget > fear ? 3.2 : 1.1;
    fear += (fearTarget - fear) * (1 - Math.exp(-dt * rate));
    pulse *= Math.exp(-dt / 0.13); // ~5% left after 0.4 s
    if (pulse < 0.002) pulse = 0;

    // heartbeat envelope (lub-dub), tempo rising with fear
    const bpm = 62 + 84 * fear;
    beatPhase = (beatPhase + (dt * bpm) / 60) % 1;
    const lub = Math.exp(-beatPhase * 9);
    const dubT = (beatPhase - 0.3 + 1) % 1;
    const dub = 0.6 * Math.exp(-dubT * 11);
    const beat = Math.min(1, lub + dub);

    const u = grade.uniforms;
    u.uTime.value = elapsed % 1000;
    u.uFear.value = fear;
    u.uPulse.value = pulse;
    u.uBeat.value = beat;
    // bloom swells very slightly with fear (lights smear when the eyes are wide)
    bloom.strength = 0.42 + 0.16 * fear + 0.25 * pulse;
  }

  /* ----------------------------------------------------------------- loop */

  const subscribers: Array<(dt: number, elapsed: number) => void> = [];
  let running = false;
  let raf = 0;
  let last = 0;
  let elapsed = 0;
  let disposed = false;

  // dynamic resolution bookkeeping
  let slowAccum = 0;
  let slowFrames = 0;

  function renderFrame(dt: number): void {
    for (const fn of subscribers.slice()) fn(dt, elapsed);
    updatePost(dt, elapsed);
    renderer.info.reset();
    composer.render(dt);
    stats.calls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;
  }

  // Count the scene pass on its own (shadow + main), without the post quads.
  const origRender = renderPass.render.bind(renderPass);
  renderPass.render = (...args: Parameters<RenderPass['render']>) => {
    const before = renderer.info.render.calls;
    origRender(...args);
    stats.sceneCalls = renderer.info.render.calls - before;
  };

  function frame(tms: number): void {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const now = tms / 1000;
    const raw = last === 0 ? 1 / 60 : now - last;
    last = now;
    const dt = Math.min(0.05, Math.max(0, raw));
    elapsed += dt;
    renderFrame(dt);

    // If the machine cannot hold ~40 fps, drop the resolution a notch (never raise it again).
    if (raw < 0.25 && document.visibilityState === 'visible') {
      slowAccum += raw;
      slowFrames++;
      if (slowAccum >= 2.5) {
        const avg = slowAccum / slowFrames;
        if (avg > 1 / 40 && quality > 0.55) {
          quality = Math.max(0.55, quality - 0.15);
          resize();
        }
        slowAccum = 0;
        slowFrames = 0;
      }
    } else {
      slowAccum = 0;
      slowFrames = 0;
    }
  }

  const engine: EngineDebug = {
    renderer,
    scene,
    camera,
    stats,
    bloom,
    start() {
      if (running || disposed) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    onUpdate(fn) {
      subscribers.push(fn);
      return () => {
        const i = subscribers.indexOf(fn);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
    setFear(level) {
      fearTarget = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
    },
    pulse(strength) {
      const s = Math.min(1, Math.max(0, Number.isFinite(strength) ? strength : 0));
      pulse = Math.max(pulse, s);
    },
    renderOnce(dt = 1 / 60) {
      if (disposed) return;
      const step = Math.min(0.05, Math.max(0, dt));
      elapsed += step;
      renderFrame(step);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onWindowResize);
      observer?.disconnect();
      subscribers.length = 0;
      bloom.dispose();
      grade.dispose();
      composer.dispose();
      target.dispose();
      renderer.dispose();
    },
  };

  return engine;
}
