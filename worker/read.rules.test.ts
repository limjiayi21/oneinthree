import { describe, expect, it } from 'vitest';
import type { WomanStrategy } from '../shared/types';
import replies from './fixtures/woman-replies.json';
import { applyWomanRules, heuristicWomanRead, ruleWomanStrategy } from './read';

const SET = replies as [string, WomanStrategy][];

describe('reply rules on top of Clef', () => {
  it('never contradicts a label in the hand-labelled set (precision 100%)', () => {
    let fired = 0;
    for (const [text, label] of SET) {
      const rule = ruleWomanStrategy(text);
      if (rule === null) continue;
      fired++;
      expect(rule, text).toBe(label);
    }
    // and they cover the cases Clef got wrong: plain greetings and small talk
    expect(fired).toBeGreaterThanOrEqual(15);
  });

  it('reads every plain greeting as friendly', () => {
    for (const t of ['Hello.', 'Hi.', 'Hey.', 'Hello?', 'Hi there.', 'Good evening.', "Hey, how's it going?", 'Oh, hi.', 'hey there!', 'Evening.', 'Hi, how are you?'])
      expect(ruleWomanStrategy(t), t).toBe('engage');
  });

  it('reads asking him to leave as a firm boundary, however politely it is put', () => {
    for (const t of ['Can you go?', 'Could you leave?', 'Can you go away?', 'Could you please leave me alone?', 'Can you just back off?', 'Please, go away.', 'Can you stop following me?', 'Will you leave, please?'])
      expect(ruleWomanStrategy(t), t).toBe('firm_boundary');
  });

  it('stays out of mixed messages and leaves them to Clef', () => {
    for (const t of ['Hi, leave me alone.', 'Hey creep.', 'Hello? Stop following me.', 'Hi, no thanks.', "Hey, I'm calling the police.", 'Please, hi, just let me go.', 'No.', 'Hey, back off.'])
      expect(ruleWomanStrategy(t), t).toBeNull();
  });

  it('a reply with no insult in it is never read as an insult, even if Clef carried one over from earlier', () => {
    const carried = { ...heuristicWomanRead('x') };
    carried.strategyProbs = { ...carried.strategyProbs };
    for (const k of Object.keys(carried.strategyProbs) as WomanStrategy[]) carried.strategyProbs[k] = k === 'hostile' ? 0.85 : 0.15 / 9;
    carried.signals = { ...carried.signals, insult: 0.1 };
    const fixed = applyWomanRules('I want to go home.', { ...carried, strategy: 'hostile', confidence: 0.85 });
    expect(fixed.strategy).toBe('firm_boundary');
    expect(fixed.strategyProbs.hostile).toBe(0);
    // a real insult stays an insult
    expect(applyWomanRules('Get lost, creep.', { ...carried, strategy: 'hostile', confidence: 0.85 }).strategy).toBe('hostile');
  });

  it('a rule outweighs a confident wrong reading but keeps the rest of it', () => {
    const wrong = { ...heuristicWomanRead('x'), strategy: 'firm_boundary' as WomanStrategy, confidence: 0.9 };
    wrong.strategyProbs = { ...wrong.strategyProbs };
    for (const k of Object.keys(wrong.strategyProbs) as WomanStrategy[]) wrong.strategyProbs[k] = k === 'firm_boundary' ? 0.9 : 0.1 / 9;
    const fixed = applyWomanRules('Hey.', wrong);
    expect(fixed.strategy).toBe('engage');
    expect(fixed.strategyProbs.engage).toBeGreaterThan(0.8);
    const sum = Object.values(fixed.strategyProbs).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 9);
    // no rule: the reading keeps its answer (only a stray insult share, with no insult in the words, is moved to a firm no)
    const kept = applyWomanRules('I really do not want to talk right now.', wrong);
    expect(kept.strategy).toBe('firm_boundary');
    expect(kept.strategyProbs.polite_deflect).toBe(wrong.strategyProbs.polite_deflect);
  });
});
