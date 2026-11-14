/**
 * His footsteps fall into step with hers.
 *
 * While he follows behind her, his footstep sounds stop coming from his own
 * walk cycle and start landing a fraction of a second after each of hers, from
 * where he is (HRTF on headphones). When she stops, one or two more of his
 * steps land before they stop too. He is behind her, so nothing on screen
 * gives the trick away; it reads as an echo that is not one.
 *
 * A lagged target makes him physically react a beat late as well.
 */

import * as THREE from 'three';
import type { Npc, Player } from '../contracts';
import type { SceneDeps, SceneKit } from './common';

export const ECHO_TUNING = {
  /** Seconds between her footfall and his. Short enough to feel like an echo. */
  delay: 0.13,
  /** He is "behind" when within this distance and outside her forward half-plane. */
  maxDistance: 14,
  /** Steps of his that still land after she stops. */
  trailingMin: 1,
  trailingMax: 2,
  /** How late he reacts physically, seconds. */
  followLag: 0.7,
} as const;

const E = ECHO_TUNING;
const _fwd = new THREE.Vector3();

export interface EchoOptions {
  deps: SceneDeps;
  kit: SceneKit;
  player: Player;
  npc: Npc;
  /** True while the echo should run (he is following and still in the scene). */
  active: () => boolean;
}

export function bindEchoSteps({ deps, kit, player, npc, active }: EchoOptions): () => void {
  let lastStep = -Infinity;
  let interval = 0.5;
  let trailing = 0;
  let trailed = 0;
  let lastSpeed = 1.4;

  const behind = (): boolean => {
    const dx = npc.position.x - player.position.x;
    const dz = npc.position.z - player.position.z;
    const d = Math.hypot(dx, dz);
    if (d > E.maxDistance || d < 0.5) return false;
    player.getForward(_fwd);
    return (dx * _fwd.x + dz * _fwd.z) / d < -0.2;
  };
  const on = () => active() && behind();

  const his = (speed: number) => {
    if (kit.ended || !active()) return;
    deps.audio.footstep('concrete', { position: npc.position, volume: 0.55 + Math.min(0.45, speed / 4), heavy: true });
  };

  const offStep = player.on('step', (s) => {
    if (!on()) return;
    const now = kit.time;
    const gap = now - lastStep;
    if (gap < 1.2) interval += (Math.min(0.85, Math.max(0.3, gap)) - interval) * 0.5;
    lastStep = now;
    lastSpeed = s.speed;
    trailed = 0;
    trailing = E.trailingMin + Math.round(Math.random() * (E.trailingMax - E.trailingMin));
    kit.after(E.delay, () => his(s.speed));
  });

  kit.onFrame(() => {
    const running = on();
    if (running) kit.muteSteps.add(npc);
    else kit.muteSteps.delete(npc);
    if (!running || trailed >= trailing) return;
    // She has stopped: his next step still lands, then maybe one more.
    if (kit.time - lastStep >= interval * (trailed + 1) + E.delay) {
      trailed++;
      his(lastSpeed);
    }
  });

  return () => {
    offStep();
    kit.muteSteps.delete(npc);
    trailing = 0;
  };
}

/** A target that trails `of` by `lag` seconds: where she was, not where she is. */
export function laggedTarget(kit: SceneKit, of: { position: THREE.Vector3 }, lag = E.followLag): () => THREE.Vector3 {
  const samples: Array<{ t: number; x: number; z: number }> = [];
  const out = new THREE.Vector3();
  kit.onFrame(() => {
    samples.push({ t: kit.time, x: of.position.x, z: of.position.z });
    while (samples.length > 2 && samples[1].t <= kit.time - lag) samples.shift();
  });
  return () => {
    const s = samples[0];
    if (!s || kit.time - s.t < lag * 0.5) return out.copy(of.position);
    return out.set(s.x, of.position.y, s.z);
  };
}
