/**
 * Sprint stamina. She can run for SPRINT_SECONDS; then she is winded for
 * WINDED_SECONDS (walking pace only, no hurrying) while the stamina waits,
 * and it refills over RECOVER_SECONDS after that. Running does not solve
 * the situation: it buys a few seconds. Pure, so it can be tested alone.
 */

export const SPRINT_SECONDS = 4;
export const WINDED_SECONDS = 6;
export const RECOVER_SECONDS = 8;
/** A new sprint needs at least this much stamina, so recovering is not a string of tiny sprints. */
export const SPRINT_RESTART = 0.5;

export interface Stamina {
  /** 0 (spent) .. 1 (fresh) */
  level: number;
  /** Seconds of breathlessness left; while above 0 she can only walk. */
  winded: number;
  running: boolean;
}

export const freshStamina = (): Stamina => ({ level: 1, winded: 0, running: false });

/** Advances stamina by dt seconds. wantRun: the player is asking to run while moving forward. */
export function stepStamina(s: Stamina, wantRun: boolean, dt: number): void {
  s.running = wantRun && s.winded <= 0 && (s.running ? s.level > 0 : s.level >= SPRINT_RESTART);
  if (s.running) {
    s.level -= dt / SPRINT_SECONDS;
    if (s.level <= 0) {
      s.level = 0;
      s.running = false;
      s.winded = WINDED_SECONDS;
    }
  } else if (s.winded > 0) {
    s.winded = Math.max(0, s.winded - dt);
  } else {
    s.level = Math.min(1, s.level + dt / RECOVER_SECONDS);
  }
}

/** 0..1, how out of breath she is: rises through a sprint, peaks as it ends, fades while winded. */
export function exertion(s: Stamina): number {
  if (s.running) return 0.3 + 0.7 * (1 - s.level);
  return s.winded / WINDED_SECONDS;
}
