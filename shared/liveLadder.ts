import type { ClientEventType, Emotion, ManDecision, TurnRequest, WorldContext } from './types';

export type Heat = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export interface LiveLadder {
  heat: Heat;
  leaving: boolean;
  heard: string;
  reply: string;
}

export const initialLiveLadder = (): LiveLadder => ({ heat: 0, leaving: false, heard: '', reply: '' });

const plain = (text: string) => text.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ').trim();
const GREETING = /^(?:(?:oh|well) )?(?:hello|hi|hey|hiya|yo|what|huh|um+|uh+|er+|hmm+|what's up|sup|good evening|how are you|how's it going)(?: there)?$/;
const REFUSAL = /\b(?:no|nope|leave me alone|stop|back off|go away|get away|not interested|don't (?:touch|follow|talk)|do not (?:touch|follow|talk)|let (?:me|go)|get out of (?:my |the )?way|move (?:aside|out of))\b/;
const INSULT = /\b(?:fuck|fucking|fucker|asshole|jerk|creep|creepy|loser|idiot|shut up|piss off|bastard|bitch|dick)\b/;
const HELP = /\b(?:(?:call|calling|phone|phoning|dial|dialing) (?:the )?(?:police|cops|911)|(?:police|cops|help)$|someone help|help me|leave her alone|she said no|back away from her)\b/;
const SOFTEN = /\b(?:sorry|thank you|thanks|just kidding|kidding|joking|haha|that's funny|my name is|i'm [a-z]+|i am [a-z]+|heading|headed|going (?:home|to)|how are you|how's it going)\b/;
const DISMISSAL = /^(?:no thanks|no thank you|busy|i'm busy|i am busy|gotta go|i have to go|whatever|fine|okay|ok|yeah|yes)$/;

/** One input is one beat. Replies can confirm a departure, never advance heat. */
export function advanceLiveLadder(state: LiveLadder, req: Pick<TurnRequest, 'event' | 'text' | 'ctx'>): LiveLadder {
  if (state.leaving || state.heat === 6) return state;
  const text = plain(req.text ?? '');
  if (req.event === 'agent_reply') {
    const leaving = state.heat >= 2 && !req.text?.includes('?') && /\b(?:i(?:'m| am) (?:leaving|gone|out|backing off)|i(?:'ll| will) (?:leave|go|back off))\b/.test(text);
    return { ...state, reply: req.text ?? '', leaving };
  }
  if (req.event === 'begin') return state;
  let heat: number = state.heat;
  if (req.event === 'speech' && text) {
    const next = { ...state, heard: req.text ?? '' };
    if (HELP.test(text) && heat >= 2) return { ...next, leaving: true };
    if (GREETING.test(text)) heat = Math.max(0, heat - 1);
    else if (INSULT.test(text)) heat++;
    // The first explicit boundary is defensive, including directly after hello.
    // This is the sole 0→2 exception; all later beats are adjacent levels.
    else if (REFUSAL.test(text) && !/^no thank/.test(text)) heat = heat < 2 ? 2 : heat + 1;
    else if (DISMISSAL.test(text)) heat = /^no thank/.test(text) && heat >= 2 ? heat + 1 : Math.max(1, heat);
    else if (SOFTEN.test(text) || text.split(' ').length > 2 || state.reply.endsWith('?')) heat = Math.max(0, heat - 1);
    else if (heat < 2) heat++;
    return { ...next, heat: Math.max(0, Math.min(6, heat)) as Heat };
  }
  if (['stood_between', 'asked_clerk'].includes(req.event) && heat >= 2) return { ...state, leaving: true };
  const walking = ['walked_past', 'sped_up', 'crossed_street', 'backed_away'].includes(req.event);
  if ((walking || req.event === 'silence') && heat === 0) heat = 1;
  else if ((walking || req.event === 'silence') && heat === 2) heat = 3;
  else if (req.event === 'pushed_past' && heat === 3) heat = 4;
  else if ((req.event === 'pushed_past' || req.event === 'backed_away') && heat === 4 && req.ctx.distanceToMan <= 1.8) heat = 5;
  // Movement and silence alone cannot trigger the cut, or repeatedly heat a chase.
  return heat === state.heat ? state : { ...state, heat: heat as Heat };
}

export function liveDecision(state: LiveLadder, ctx: WorldContext): ManDecision {
  if (state.leaving) return { stance: 'back_off', action: 'leave', emotion: 'sheepish', emotionIntensity: 0.7, proximity: 4 };
  const stances = ['opening', 'persist', 'guilt', 'follow', 'block', 'intimidate', 'escalate'] as const;
  const emotions: Emotion[] = ['friendly', 'smirk', 'sheepish', 'annoyed', 'angry', 'angry', 'angry'];
  const actions = ['approach', 'walk_alongside', 'step_closer', ctx.playerSpeed > 2 ? 'run_after' : 'follow_behind', 'block_path', 'pull_arm', 'grab'] as const;
  return {
    stance: stances[state.heat], action: actions[state.heat], emotion: emotions[state.heat],
    emotionIntensity: state.heat < 2 ? 0.4 : 0.45 + state.heat * 0.08,
    proximity: [2.4, 1.6, 1.2, 1.7, 1, 0.65, 0.65][state.heat],
  };
}

export function liveOutcome(state: LiveLadder, event: ClientEventType) {
  if (state.heat === 6) return 'escalated' as const;
  if (event === 'entered_shop') return 'took_refuge' as const;
  if (event === 'reached_home' || event === 'scene_timeout') return state.leaving ? 'reached_home_alone' as const : 'reached_home_followed' as const;
  return undefined;
}
