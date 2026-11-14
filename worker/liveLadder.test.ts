import { describe, expect, it } from 'vitest';
import { advanceLiveLadder, initialLiveLadder, liveDecision, liveOutcome, type Heat, type LiveLadder } from '../shared/liveLadder';
import type { ClientEventType, WorldContext } from '../shared/types';

const ctx: WorldContext = { elapsed: 10, distanceToMan: 1.4, progress: 0.2, playerSpeed: 0, facingMan: true, manBlocking: false, oppositeSidewalk: false };
const at = (heat: Heat): LiveLadder => ({ ...initialLiveLadder(), heat });
const beat = (state: LiveLadder, text: string, event: ClientEventType = 'speech', world = ctx) => advanceLiveLadder(state, { event, text, ctx: world });

describe('live escalation ladder', () => {
  it.each(['Hello', 'hi!', 'what?', 'um', 'How are you?', 'Good evening', 'hello there'])('keeps %s friendly at zero', (text) => {
    const state = beat(at(0), text);
    expect(state.heat).toBe(0);
    expect(liveDecision(state, ctx)).toMatchObject({ stance: 'opening', action: 'approach', emotion: 'friendly' });
    expect(state.leaving).toBe(false);
  });

  it('keeps a brush-off pressing, then a clear refusal defensive, then follows the second no', () => {
    let state = beat(at(0), 'no thanks');
    expect(state.heat).toBe(1);
    state = beat(state, 'Leave me alone.');
    expect(liveDecision(state, ctx)).toMatchObject({ stance: 'guilt', action: 'step_closer', emotion: 'sheepish' });
    state = beat(state, 'I said no.');
    expect(liveDecision(state, ctx)).toMatchObject({ stance: 'follow', action: 'follow_behind', emotion: 'annoyed' });
    state = beat(state, 'Stop following me.');
    expect(liveDecision(state, ctx).action).toBe('block_path');
    state = beat(state, 'Let me go.');
    expect(liveDecision(state, ctx).action).toBe('pull_arm');
    state = beat(state, 'No!');
    expect(liveDecision(state, ctx).action).toBe('grab');
    expect(liveOutcome(state, 'speech')).toBe('escalated');
  });

  it('makes the first clear boundary defensive even directly after a hello', () => {
    const state = beat(beat(at(0), 'hello'), 'leave me alone');
    expect(state.heat).toBe(2);
    expect(liveDecision(state, ctx).action).toBe('step_closer');
  });

  it.each(['silence', 'walked_past', 'sped_up', 'crossed_street', 'backed_away'] as const)('follows after defensive when she %s', (event) => {
    const state = beat(at(2), '', event, { ...ctx, playerSpeed: 2.6 });
    expect(state.heat).toBe(3);
    expect(liveDecision(state, { ...ctx, playerSpeed: 2.6 }).action).toBe('run_after');
    expect(beat(state, '', event).heat).toBe(3);
  });

  it('never cuts on movement or silence and pulls only after blocking within reach', () => {
    expect(beat(at(3), '', 'pushed_past').heat).toBe(4);
    expect(beat(at(4), '', 'backed_away', { ...ctx, distanceToMan: 4 }).heat).toBe(4);
    expect(beat(at(4), '', 'backed_away').heat).toBe(5);
    for (const event of ['silence', 'sped_up', 'backed_away', 'pushed_past'] as const) {
      expect(beat(at(5), '', event).heat).toBe(5);
    }
  });

  it('raises insults one step, cools answers one step, and never resets a hot greeting to guilt', () => {
    for (const heat of [0, 1, 2, 3, 4, 5] as Heat[]) {
      expect(beat(at(heat), 'You creep').heat).toBe(heat + 1);
      expect(beat(at(heat), "Sorry, I'm just going home.").heat).toBe(Math.max(0, heat - 1));
      expect(beat(at(heat), 'hello').heat).toBe(Math.max(0, heat - 1));
    }
    expect(beat(at(4), 'no thanks').heat).toBe(5);
  });

  it.each(['I am calling the police', 'Help! Someone help!', 'Leave her alone'])('allows leaving for %s from defensive or higher', (text) => {
    expect(beat(at(2), text).leaving).toBe(true);
    expect(liveDecision(beat(at(5), text), ctx).action).toBe('leave');
    expect(beat(at(0), text).leaving).toBe(false);
  });

  it('uses his actual reply to confirm departure but cannot escalate from his words alone', () => {
    const state = beat(at(3), "Fine, I'll leave you alone.", 'agent_reply');
    expect(state.leaving).toBe(true);
    expect(state.reply).toContain("I'll leave");
    expect(beat(at(0), 'Your loss, I am leaving.', 'agent_reply').leaving).toBe(false);
    expect(beat(at(2), 'Get back here!', 'agent_reply').heat).toBe(2);
    expect(beat(at(2), 'Why should I leave you alone?', 'agent_reply').leaving).toBe(false);
    expect(beat(at(2), "I'm not leaving you alone.", 'agent_reply').leaving).toBe(false);
  });
});
