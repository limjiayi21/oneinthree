import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { bindEchoSteps, ECHO_TUNING, laggedTarget } from './echoSteps';
import type { SceneDeps, SceneKit } from './common';
import type { Npc, Player } from '../contracts';

/** Just enough of the scene kit, player and audio to drive the echo. */
function rig(manAt: THREE.Vector3) {
  const timers: Array<{ at: number; fn: () => void }> = [];
  const frames: Array<(dt: number) => void> = [];
  const kit = {
    time: 0,
    ended: false,
    muteSteps: new Set<Npc>(),
    after(s: number, fn: () => void) {
      timers.push({ at: kit.time + s, fn });
      return () => {};
    },
    onFrame(fn: (dt: number) => void) {
      frames.push(fn);
    },
  };
  let stepCb: ((s: { speed: number }) => void) | null = null;
  const player = {
    position: new THREE.Vector3(0, 0, 0),
    getForward: (out = new THREE.Vector3()) => out.set(0, 0, -1), // facing -Z
    on: (_e: string, cb: (s: { speed: number }) => void) => {
      stepCb = cb;
      return () => (stepCb = null);
    },
  };
  const npc = { position: manAt.clone() };
  const heard: number[] = [];
  const deps = { audio: { footstep: () => heard.push(kit.time) } };
  let following = true;

  bindEchoSteps({
    deps: deps as unknown as SceneDeps,
    kit: kit as unknown as SceneKit,
    player: player as unknown as Player,
    npc: npc as unknown as Npc,
    active: () => following,
  });

  const advance = (seconds: number, stepEvery?: number) => {
    const dt = 1 / 60;
    let nextStep = stepEvery ? kit.time : Infinity;
    for (let t = 0; t < seconds; t += dt) {
      kit.time += dt;
      if (stepEvery && kit.time >= nextStep) {
        nextStep += stepEvery;
        stepCb?.({ speed: 1.4 });
      }
      for (const f of frames) f(dt);
      for (let i = timers.length - 1; i >= 0; i--) {
        if (timers[i].at <= kit.time) timers.splice(i, 1)[0].fn();
      }
    }
  };
  return { kit, npc, heard, advance, stop: () => (following = false) };
}

describe('echo steps', () => {
  it('lands one of his steps just after each of hers while he is behind her', () => {
    const r = rig(new THREE.Vector3(0, 0, 5)); // 5 m behind (she faces -Z)
    r.advance(3, 0.5);
    expect(r.heard.length).toBeGreaterThanOrEqual(5);
    expect(r.kit.muteSteps.has(r.npc as unknown as Npc)).toBe(true);
  });

  it('keeps one or two steps going after she stops, then goes quiet', () => {
    const r = rig(new THREE.Vector3(0, 0, 5));
    r.advance(2, 0.5);
    const walking = r.heard.length;
    r.advance(3); // she stands still
    const extra = r.heard.length - walking;
    expect(extra).toBeGreaterThanOrEqual(ECHO_TUNING.trailingMin);
    expect(extra).toBeLessThanOrEqual(ECHO_TUNING.trailingMax + 1); // +1: the echo of her last step
    const settled = r.heard.length;
    r.advance(2);
    expect(r.heard.length).toBe(settled);
  });

  it('does nothing when he is in front of her, and gives his own steps back', () => {
    const r = rig(new THREE.Vector3(0, 0, -5)); // ahead of her
    r.advance(3, 0.5);
    expect(r.heard.length).toBe(0);
    expect(r.kit.muteSteps.size).toBe(0);
  });

  it('stops when he is no longer following', () => {
    const r = rig(new THREE.Vector3(0, 0, 5));
    r.advance(1, 0.5);
    r.stop();
    const before = r.heard.length;
    r.advance(2, 0.5);
    expect(r.heard.length).toBeLessThanOrEqual(before + 1); // at most an echo already in flight
    expect(r.kit.muteSteps.size).toBe(0);
  });
});

describe('laggedTarget', () => {
  it('reports where she was a beat ago', () => {
    const frames: Array<(dt: number) => void> = [];
    const kit = { time: 0, onFrame: (fn: (dt: number) => void) => frames.push(fn) };
    const her = { position: new THREE.Vector3() };
    const target = laggedTarget(kit as unknown as SceneKit, her, 0.7);
    for (let i = 0; i < 120; i++) {
      kit.time += 1 / 60;
      her.position.z = -1.4 * kit.time; // walking at 1.4 m/s
      for (const f of frames) f(1 / 60);
    }
    expect(target().z).toBeCloseTo(-1.4 * (kit.time - 0.7), 1);
  });
});
