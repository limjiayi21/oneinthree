import { describe, expect, it } from 'vitest';
import { RECOVER_SECONDS, SPRINT_RESTART, SPRINT_SECONDS, WINDED_SECONDS, exertion, freshStamina, stepStamina } from './stamina';

const DT = 1 / 60;
function run(s: ReturnType<typeof freshStamina>, wantRun: boolean, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) stepStamina(s, wantRun, DT);
}

describe('sprint stamina', () => {
  it('sprints for SPRINT_SECONDS, then is winded and cannot run until it recovers', () => {
    const s = freshStamina();
    run(s, true, SPRINT_SECONDS - 0.1);
    expect(s.running).toBe(true);
    run(s, true, 0.2);
    expect(s.running).toBe(false);
    expect(s.winded).toBeGreaterThan(0);
    expect(exertion(s)).toBeGreaterThan(0.9); // most out of breath right as the sprint ends

    run(s, true, WINDED_SECONDS - 0.4); // still asking to run: refused while winded (about 0.3 s of it left)
    expect(s.running).toBe(false);
    expect(s.level).toBe(0);

    run(s, true, 0.3 + SPRINT_RESTART * RECOVER_SECONDS - 0.2); // not quite enough back
    expect(s.running).toBe(false);
    run(s, true, 0.4);
    expect(s.running).toBe(true); // half a tank: can sprint again
  });

  it('a short sprint and a rest is not winded and refills', () => {
    const s = freshStamina();
    run(s, true, 1);
    run(s, false, RECOVER_SECONDS);
    expect(s.winded).toBe(0);
    expect(s.level).toBe(1);
    expect(exertion(s)).toBe(0);
  });
});
