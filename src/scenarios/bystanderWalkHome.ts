/**
 * Part 2: the same street, as a bystander a few steps behind her. Short and sidewalk only, like
 * Part 1's demo: the same stretch, him in the same spot, and the shop just past him.
 * A scripted exchange between the man and the woman plays out unless the
 * player does something; from the first intervention the decision model takes
 * over both characters.
 */
import * as THREE from 'three';
import type { Npc } from '../contracts';
import type { ManDecision, OutcomeKind, SpeechTarget, TurnEvent, WomanDecision } from '../../shared/types';
import { createPlayer } from '../player/player';
import { createHuman } from '../characters/human';
import { createNpc } from '../characters/npc';
import { SCRIPT, SceneKit, clamp01, inRect, voUrl, type SceneDeps, type SceneResult } from './common';
import { bindHandActions } from './handActions';
import { HOME, LINE, ROAD_HALF, rect, shopPocket } from '../world/layout';
import { DEMO } from './womanDemo';
import type { MomentOption } from '../contracts';
import { LEVELS } from '../../shared/levels';
import { reducedMotion } from '../ui/dom';
import { runKeyTutorial } from './keyTutorial';
import { matchSpoken, type SpokenChoice } from './speechMatch';

/** How long a moment stays open, in real seconds, if the player does nothing. */
const TIP_SECONDS = 15;
/**
 * While a moment is open the street slows to this fraction of real time. Set so an open moment
 * covers the same 2.4 s of story it always did (0.3 x 8 s), however long the timer is: the scripted
 * beats around each moment are timed in story seconds.
 */
const SLOW = 2.4 / TIP_SECONDS;
/** When a moment opens the view eases this many degrees tighter (70 to 63, about 10% closer). */
const ZOOM_DEG = 7;

/** What an option does. Analog: pressing its number does it. Immersive: the player has to do it for real. */
type Act = { kind: 'say'; line: string; to: 'man' | 'woman' } | { kind: 'film' } | { kind: 'help' } | { kind: 'look' } | { kind: 'walk' };
type Option = MomentOption & { act: Act };
type MomentId = 'm1' | 'm2' | 'm3' | 'm4' | 'm5';

const say = (text: string, to: 'man' | 'woman', tag: string): Option => ({ icon: 'speak', text: `"${text}"`, tag, how: 'Say it', act: { kind: 'say', line: text, to } });
const FILM: Option = { icon: 'film', text: 'Film him', tag: 'Document', how: 'Look down, pinch', act: { kind: 'film' } };
/** Called out from where you stand: the shop is a few metres past them. */
const HELP_LINE = "Hey! Can you come out here? He won't leave her alone.";
const HELP: Option = { icon: 'help', text: 'Call the shopkeeper', tag: 'Delegate', how: 'Look at the shop, say it', act: { kind: 'help' } };
/** Letting a moment pass. The words are the bystander's own excuse, as in the script's thoughts. */
const excuse = (text: string): Option => ({ icon: 'walk', text, tag: 'Do nothing', how: 'Let it pass', act: { kind: 'walk' } });

/**
 * The moments, each right after a line of the script, so the options answer what was just said.
 * A shaded tip (the bystander's thought), and one row of options. Letting it pass is the excuse.
 * m5 comes only if he leaves. Ids as in content/guided.json.
 */
const MOMENTS: Record<MomentId, { tip: string; options: Option[] }> = {
  // After "I'm talking to you. What, you can't say hi?" He walks beside her.
  m1: {
    tip: 'Do they know each other?',
    options: [say('Hey, you alright?', 'woman', 'Check in'), { icon: 'look', text: 'Catch her eye', tag: 'Notice', how: 'Look at her', act: { kind: 'look' } }, excuse('Hang back and watch')],
  },
  // After "Come on, slow down. Let me walk you home." She speeds up.
  m2: { tip: "She's trying to get away from him.", options: [say("Hey! Sorry I'm late, you ready?", 'woman', 'Distract'), HELP, FILM, excuse("It's probably nothing")] },
  // He blocks her. "Please. I just want to get home."
  m3: {
    tip: "She can't get past him.",
    options: [say('Leave her alone, man.', 'man', 'Direct'), say("Excuse me, which way's the subway?", 'man', 'Distract'), HELP, excuse('Someone should say something')],
  },
  // After "Leave me alone." The last chance: letting this one pass ends with him grabbing her.
  m4: {
    tip: "There is no one else here. It's you.",
    options: [say('Hey! Back off. Leave her alone.', 'man', 'Direct'), say("I'm calling the police.", 'man', 'Delegate'), say('Back off, creep. You want a problem?', 'man', 'Insult, risky'), excuse('Look away')],
  },
  // He has gone.
  m5: { tip: "She's shaking.", options: [say('Are you okay? Want me to walk with you?', 'woman', 'Delay'), say('Do you want me to call someone?', 'woman', 'Delay'), excuse('Leave her be')] },
};

/**
 * Where everyone starts: you a few steps behind her on her sidewalk, him leaning on the wall where
 * he waits in Part 1's demo, and the shop about 12 m past him, so the shopkeeper is in reach.
 */
const STAGE = {
  player: new THREE.Vector3(6.6, 0, -44),
  woman: new THREE.Vector3(6.5, 0, -52),
  man: DEMO.manSpot,
};

/** Her scream at the grab (content/sfx.json, rendered by npm run gen:sfx). If it is missing only the gasp is heard. */
const SCREAM_URL = '/audio/sfx/scream.mp3';

/** His level (0 calm .. 6 physical) for each stance the decision model can put him in. */
const STANCE_LEVEL: Partial<Record<ManDecision['stance'], number>> = { idle: 0, opening: 1, persist: 2, follow: 2, guilt: 3, hostile: 4, intimidate: 5, block: 5, escalate: 6, back_off: 1, gone: 0 };

export async function runBystanderWalkHome(deps: SceneDeps): Promise<SceneResult> {
  const { engine, world, audio, hud } = deps;
  const P = world.points;

  const player = createPlayer(engine, world, {
    body: 'bystander',
    requireLock: deps.requireLock,
    eyes: deps.eyes,
    extraMove: () => deps.phone?.move(performance.now()) ?? null,
    // Only this street, where it happens: not back the way you came, not off down a side street.
    // Her sidewalk only, from just behind your start on past the shop to just beyond her building, plus the shop.
    corridor: [rect(ROAD_HALF, LINE, HOME.z1 - 1.5, STAGE.player.z + 1.5), shopPocket()],
    onCorridorEdge: (edge) => hud.hint(edge === 'back' ? 'Stay with her.' : edge === 'ahead' ? 'The street ends here.' : 'Stay on the sidewalk.', 3000),
  });
  const kit = new SceneKit(deps, player, 'bystander');

  /* ---------------------------------------------------------------- cast */

  const man: Npc = createNpc(
    createHuman({ build: 'man', height: 1.86, hairStyle: 'buzz', topStyle: 'hoodie', top: 0x2b2f38, bottom: 0x1d2330, shoes: 0x101010 }),
    engine.scene,
  );
  const woman: Npc = createNpc(
    createHuman({ build: 'woman', height: 1.66, hairStyle: 'ponytail', topStyle: 'coat', top: 0x6a5546, bottom: 0x22252c, accessory: 'tote' }),
    engine.scene,
  );
  const clerk: Npc = createNpc(
    createHuman({ build: 'man', height: 1.72, hairStyle: 'short', topStyle: 'apron', top: 0x3d5a4c, bottom: 0x2a2a2e }),
    engine.scene,
  );
  kit.addNpc(man, true);
  kit.addNpc(woman, false);
  kit.addNpc(clerk, false);
  const playerBody = { getPosition: () => player.position, radius: 0.34 };
  man.addAvoid(playerBody);
  man.addAvoid(woman);
  woman.addAvoid(playerBody);
  woman.addAvoid(man);
  clerk.addAvoid(playerBody);

  man.setPose(STAGE.man, Math.PI / 2);
  man.human.setPosture('lean_wall');
  man.human.playGesture('check_phone');
  woman.setPose(STAGE.woman, 0);
  woman.human.setPosture('guarded');
  woman.human.setEmotion('neutral', 0.3);
  clerk.setPose(P.clerkSpot, Math.PI / 2);

  /* --------------------------------------------------------------- state */

  let started = false; // the scripted exchange has begun
  let dynamic = false; // the decision model has taken over
  let manFocus: 'woman' | 'player' = 'woman';
  let manGone = false;
  let womanGone = false;
  let filming = false;
  let finishing = false;
  let speechSeq = 0;
  let lastSpeech: Promise<void> = Promise.resolve();
  let cancelSilence: (() => void) | null = null;
  let betweenFor = 0;
  /** Lines and decisions heard from the model, so a silent reply to an action can be noticed. */
  let heard = 0;
  /** She looks at the player until this scene time (she has seen the phone). */
  let womanLooksUntil = -1;
  const beatCancels: Array<() => void> = [];
  let beat = 'before';
  const once = new Set<string>();
  const first = (key: string) => (once.has(key) ? false : (once.add(key), true));

  const eye = new THREE.Vector3();
  const manHead = new THREE.Vector3();
  const womanHead = new THREE.Vector3();
  const clerkHead = new THREE.Vector3();
  const v1 = new THREE.Vector3();

  const womanPos = () => woman.position;
  const manPos = () => man.position;
  const womanFwd = () => v1.set(0, 0, -1).clone();
  const focusPos = () => (manFocus === 'player' ? player.position : woman.position);
  const focusFwd = () => (manFocus === 'player' ? player.getForward(new THREE.Vector3()) : new THREE.Vector3(0, 0, -1));

  function lookingAt(): SpeechTarget {
    const candidates: Array<[SpeechTarget, THREE.Vector3, boolean]> = [
      ['man', man.human.getHeadPosition(manHead), !manGone],
      ['woman', woman.human.getHeadPosition(womanHead), !womanGone],
      ['clerk', clerk.human.getHeadPosition(clerkHead), true],
    ];
    let best: SpeechTarget = 'nobody';
    let bestD = Infinity;
    for (const [who, head, present] of candidates) {
      if (!present) continue;
      const d = head.distanceTo(eye);
      if (d < 14 && player.isLookingAt(head, 22) && d < bestD) {
        best = who;
        bestD = d;
      }
    }
    if (best !== 'nobody') return best;
    // Not looking at anyone in particular: whoever is closest, if close.
    for (const [who, head, present] of candidates) {
      if (!present) continue;
      const d = head.distanceTo(eye);
      if (d < 3.5 && d < bestD) {
        best = who;
        bestD = d;
      }
    }
    return best;
  }

  function isBetween(): boolean {
    if (manGone || womanGone) return false;
    const a = man.position;
    const b = woman.position;
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    if (len2 < 0.04 || len2 > 20) return false;
    const t = ((player.position.x - a.x) * abx + (player.position.z - a.z) * abz) / len2;
    if (t < 0.15 || t > 0.85) return false;
    const cx = a.x + abx * t;
    const cz = a.z + abz * t;
    return Math.hypot(player.position.x - cx, player.position.z - cz) < 0.9;
  }

  kit.context = () => ({
    elapsed: kit.time,
    distanceToMan: manGone ? 99 : man.distanceTo(player.position),
    distanceToWoman: womanGone ? 99 : woman.distanceTo(player.position),
    progress: clamp01((P.subwayExit.z - player.position.z) / (P.subwayExit.z - P.homeStoop.z)),
    playerSpeed: player.speed,
    facingMan: !manGone && player.isLookingAt(man.human.getHeadPosition(manHead), 35),
    manBlocking: man.behaviour === 'block',
    oppositeSidewalk: player.position.x < -4.5,
    lookingAt: lookingAt(),
    filming,
    betweenThem: isBetween(),
    beat,
  });

  /* ------------------------------------------------------ scripted scene */

  const sayScripted = (npc: Npc, id: string) => {
    const line = SCRIPT[id];
    if (!line) return Promise.resolve();
    npc.human.setEmotion(line.emotion, 0.85);
    const speaker = line.speaker === 'woman' ? 'woman' : line.speaker === 'clerk' ? 'clerk' : 'man';
    lastSpeech = kit.say(npc, speaker, line.text, voUrl(id));
    return lastSpeech;
  };
  const herThought = (id: string) => kit.think(id, { quiet: true, intensity: 0.5 });

  function at(seconds: number, name: string, fn: () => void): void {
    beatCancels.push(
      kit.after(seconds, () => {
        if (dynamic || kit.ended || finishing) return;
        beat = name;
        fn();
      }),
    );
  }

  function startScript(): void {
    started = true;
    kit.speechEnabled = true;
    kit.refreshMic();

    at(0, 'call_out', () => {
      setLevel(1);
      man.human.setPosture('relaxed');
      man.human.setGaze(woman.human.getHeadPosition(womanHead));
      man.human.playGesture('beckon');
      void sayScripted(man, 'b_m1');
      woman.human.setEmotion('worried', 0.5);
      kit.serverFear = 0.12;
    });
    at(1.9, 'call_out', () => herThought('b_t1'));
    at(3.6, 'alongside', () => {
      setLevel(2);
      man.setBehaviour({ type: 'walkAlongside', target: womanPos, targetForward: womanFwd, side: 'left', gap: 1.0 });
    });
    at(5.6, 'alongside', () => void sayScripted(man, 'b_m2'));
    at(8.2, 'alongside', () => offer('m1'));
    at(9.2, 'deflect', () => void sayScripted(woman, 'b_w1'));
    at(13.2, 'walk_you_home', () => {
      setLevel(3);
      man.human.playGesture('open_arms');
      void sayScripted(man, 'b_m3');
      woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.85 });
      woman.human.setEmotion('afraid', 0.55);
      kit.serverFear = 0.2;
    });
    at(15.6, 'walk_you_home', () => offer('m2'));
    at(15.8, 'walk_you_home', () => herThought('b_t2'));
    at(19.2, 'blocks', () => {
      setLevel(4);
      man.setBehaviour({ type: 'block', target: womanPos, targetForward: womanFwd, gap: 1.1 });
      woman.setBehaviour({ type: 'idle', face: manPos });
      woman.human.playGesture('clutch_bag');
    });
    at(20.8, 'blocks', () => {
      man.human.playGesture('shrug');
      void sayScripted(man, 'b_m4');
    });

    at(24.6, 'pleads', () => {
      woman.setBehaviour({ type: 'backAway', from: manPos, distance: 0.8, speed: 0.9 });
      void sayScripted(woman, 'b_w2');
    });
    at(26.8, 'pleads', () => herThought('b_t3'));
    at(26.0, 'pleads', () => offer('m3'));
    at(29.4, 'hostile', () => {
      setLevel(5);
      man.setBehaviour({ type: 'closeIn', target: womanPos, gap: 0.85, speed: 1.3 });
      man.human.setPosture('aggressive');
      man.human.playGesture('point');
      void sayScripted(man, 'b_m5');
      woman.human.setEmotion('afraid', 0.9);
      woman.human.setPosture('cower');
      kit.serverFear = 0.38;
    });
    at(34.2, 'hostile', () => {
      void sayScripted(woman, 'b_w3');
      woman.setBehaviour({ type: 'backAway', from: manPos, distance: 1.2, speed: 1.1 });
    });
    at(35.6, 'hostile', () => offer('m4'));
    at(39.4, 'hostile', () => herThought('b_t4'));
    at(43.5, 'timeout', () => void kit.turn({ event: 'scene_timeout', ctx: kit.context() }));
    // If the server never answers: in this simulation, nobody stepping in always ends with him grabbing her.
    at(49, 'timeout', () => void finish('no_intervention_escalated'));
  }

  /* ------------------------------------------------- teaching moments */

  // At five moments the street slows and the options fade in around a centre icon. Analog: 1 to 4 does
  // an option. Immersive: only doing it for real counts (speaking, pinching, a raised hand, looking).
  const mode = deps.mode ?? 'analog';
  let open: { options: Option[] } | null = null;
  let cancelMoment: (() => void) | null = null;
  let lookFor = 0;
  /** Scene time the open moment runs out (letting it pass is the walk option). */
  let momentEnds = 0;
  /** Immersive: she spoke at the open moment and we are waiting to hear what she said; the timer is held. */
  let awaitingWords = false;
  let heldLeft = 0;
  let awaitingSince = 0;

  function armMomentTimer(seconds: number): void {
    cancelMoment?.();
    momentEnds = kit.time + seconds;
    cancelMoment = kit.after(seconds, () => did('walk'));
  }
  /** Stop the moment running out while what she said is transcribed; picking happens once it is heard. */
  function holdForWords(): void {
    if (awaitingWords || !open) return;
    awaitingWords = true;
    awaitingSince = performance.now();
    heldLeft = Math.max(0.5, momentEnds - kit.time);
    cancelMoment?.();
    cancelMoment = null;
    hud.holdMoment(true);
  }
  /** Nothing she said matched (or it was not caught): the moment carries on where it was. */
  function releaseWords(): void {
    if (!awaitingWords) return;
    awaitingWords = false;
    hud.holdMoment(false);
    if (open) armMomentTimer(heldLeft);
  }
  /** What she said, matched to the open moment's spoken options (and calling the shopkeeper). */
  function pickFromWords(text: string): void {
    if (!awaitingWords || !open) return;
    const choices: SpokenChoice[] = [];
    open.options.forEach((o, index) => {
      if (o.act.kind === 'say') choices.push({ index, line: o.act.line, tag: o.tag ?? '' });
      else if (o.act.kind === 'help') choices.push({ index, line: HELP_LINE, tag: o.tag ?? 'Delegate' });
    });
    let index = text ? matchSpoken(text, choices) : -1;
    // Spoken towards the shop with no clearer match: that is calling the shopkeeper.
    if (index < 0 && text && lookingAt() === 'clerk') index = open.options.findIndex((o) => o.act.kind === 'help');
    if (index < 0) {
      releaseWords();
      return;
    }
    awaitingWords = false;
    hud.holdMoment(false);
    if (open.options[index]!.act.kind === 'help') {
      did('help');
      callShopkeeper();
    } else endTip(index);
  }

  function offer(id: MomentId): void {
    if (kit.ended || finishing || !first(`moment_${id}`)) return;
    endTip();
    const m = MOMENTS[id];
    open = { options: m.options };
    lookFor = 0;
    kit.timeScale = SLOW;
    if (!reducedMotion()) player.setZoom(ZOOM_DEG);
    hud.moment({ tip: m.tip, options: m.options, mode, seconds: TIP_SECONDS });
    // Scene time, so a pause does not run it down. Letting it pass is the walk option.
    armMomentTimer(TIP_SECONDS * SLOW);
  }

  /** Close the moment; with `picked`, that option lights up for a moment first. */
  function endTip(picked?: number): void {
    cancelMoment?.();
    cancelMoment = null;
    if (awaitingWords) {
      awaitingWords = false;
      hud.holdMoment(false);
    }
    if (!open) return;
    open = null;
    kit.timeScale = 1;
    player.setZoom(0);
    if (picked === undefined || picked < 0) {
      hud.moment(null);
      return;
    }
    hud.momentPicked(picked);
    kit.after(1, () => open || hud.moment(null));
  }

  /** The player did something: the matching option at the open moment, if any, counts as picked. */
  function did(kind: Act['kind']): void {
    if (open) endTip(open.options.findIndex((o) => o.act.kind === kind));
  }

  /** Analog: do the option for the player. */
  function act(a: Act): void {
    if (a.kind === 'say') {
      hud.subtitle('you', a.line, 3200);
      void kit.turn({ event: 'speech', ctx: { ...kit.context(), lookingAt: a.to }, text: a.line, source: 'typed' });
    } else if (a.kind === 'film') {
      if (!filming) kit.onKey('KeyF');
    } else if (a.kind === 'help') {
      hud.subtitle('you', HELP_LINE, 3200);
      callShopkeeper();
    } else if (a.kind === 'look') {
      catchHerEye();
    }
  }

  /** Delegate: the shopkeeper hears you and comes to his door. */
  function callShopkeeper(): void {
    if (once.has('clerkAsked')) return;
    once.add('clerkAsked');
    hud.prompt(null);
    kit.event('asked_clerk');
  }

  /** You look at her; she looks back at you for a moment. */
  function catchHerEye(): void {
    player.glanceAt(woman.human.getHeadPosition(womanHead), 2, 0.8);
    womanLooksUntil = kit.time + 2;
  }

  const onDigit = (e: KeyboardEvent): void => {
    if (mode !== 'analog' || !open || e.repeat || kit.paused || e.altKey || e.ctrlKey || e.metaKey) return;
    const match = /^(?:Digit|Numpad)([1-4])$/.exec(e.code);
    const index = match ? Number(match[1]) - 1 : -1;
    const option = open.options[index];
    if (!option) return;
    e.preventDefault();
    endTip(index);
    act(option.act);
  };
  window.addEventListener('keydown', onDigit);

  /* ------------------------------------------------- his level */

  let level = 0;
  function setLevel(next: number): void {
    level = Math.max(0, Math.min(6, Math.round(next)));
    hud.setLevel(level, LEVELS[level]?.name ?? '');
  }

  function takeOver(): void {
    if (dynamic) return;
    dynamic = true;
    // Speaking up (or any intervention) moves the story off the script: a pending scripted moment no longer fits.
    endTip();
    for (const c of beatCancels.splice(0)) c();
    beat = 'intervention';
  }

  /* ------------------------------------------------- model-driven scene */

  function applyMan(d: ManDecision): void {
    setLevel(d.level ?? STANCE_LEVEL[d.stance] ?? level);
    man.human.setEmotion(d.emotion, d.emotionIntensity);
    const gap = Math.max(0.7, d.proximity);
    if (d.action === 'turn_on_bystander') manFocus = 'player';
    else if (d.action !== 'stay') manFocus = d.stance === 'hostile' && manFocus === 'player' ? 'player' : manFocus;

    man.human.setPosture(d.stance === 'hostile' || d.stance === 'intimidate' ? 'aggressive' : d.stance === 'back_off' ? 'stand' : 'relaxed');

    switch (d.action) {
      case 'stay':
        man.setBehaviour({ type: 'idle', face: focusPos });
        break;
      case 'turn_on_bystander':
        man.setBehaviour({ type: 'closeIn', target: () => player.position, gap: Math.max(1.2, gap), speed: 1.6 });
        kit.scare(0.35);
        break;
      case 'approach':
      case 'step_closer':
      case 'lean_in':
        man.setBehaviour({ type: 'closeIn', target: focusPos, gap: Math.max(0.85, gap), speed: 1.4 });
        if (d.action === 'lean_in') man.human.playGesture('lean_in');
        if (manFocus === 'player') kit.after(0.5, () => man.distanceTo(player.position) < 1.4 && player.stepBack(man.position, 0.5, 0.45));
        break;
      case 'walk_alongside':
        man.setBehaviour({ type: 'walkAlongside', target: focusPos, targetForward: focusFwd, side: 'left', gap: Math.max(0.9, gap) });
        break;
      case 'follow_behind':
        man.setBehaviour({ type: 'followBehind', target: focusPos, gap: Math.max(2.2, gap) });
        break;
      case 'block_path':
        man.setBehaviour({ type: 'block', target: focusPos, targetForward: focusFwd, gap: Math.max(1.0, gap) });
        break;
      case 'back_away':
        man.setBehaviour({ type: 'backAway', from: focusPos, distance: 3, speed: 1.1 });
        man.human.playGesture('hands_up');
        break;
      case 'leave':
        manLeaves();
        break;
      case 'grab':
        man.setBehaviour({ type: 'closeIn', target: focusPos, gap: 0.7, speed: 2.2 });
        man.human.playGesture('reach');
        break;
      default:
        break;
    }
    if (d.stance === 'gone') manLeaves();
  }

  function manLeaves(): void {
    if (manGone) return;
    manGone = true;
    man.human.setGaze(null);
    man.human.playGesture('dismiss');
    man.setBehaviour({ type: 'leave', to: P.nearCorner, speed: 1.5 });
    kit.serverFear = Math.min(kit.serverFear, 0.15);
    // He has gone and she is shaken: what do you say to her?
    kit.after(1.8, () => !womanGone && !finishing && offer('m5'));
  }

  function applyWoman(d: WomanDecision): void {
    if (womanGone) return;
    woman.human.setEmotion(d.emotion, 0.85);
    woman.human.setPosture(d.emotion === 'afraid' ? 'cower' : d.emotion === 'relieved' ? 'stand' : 'guarded');
    switch (d.action) {
      case 'keep_walking':
        woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.45 });
        break;
      case 'stop':
      case 'freeze':
        woman.setBehaviour({ type: 'idle', face: manGone ? () => player.position : manPos });
        break;
      case 'step_back':
        woman.setBehaviour({ type: 'backAway', from: manPos, distance: 1.1, speed: 1.0 });
        break;
      case 'move_to_player':
        woman.setBehaviour({ type: 'closeIn', target: () => player.position, gap: 1.2, speed: 1.9 });
        break;
      case 'hurry_home':
        woman.setBehaviour({ type: 'leave', to: P.homeStoop, speed: 2.5 });
        void woman.arrived().then(() => (womanGone = true));
        break;
      case 'enter_shop':
        woman.setBehaviour({ type: 'leave', to: P.shopInside, speed: 2.2 });
        void woman.arrived().then(() => (womanGone = true));
        break;
      default:
        break;
    }
  }

  function armSilenceTimer(): void {
    cancelSilence?.();
    if (kit.ended || finishing || !dynamic) return;
    const turnAtArm = kit.turnCount;
    cancelSilence = kit.after(6 + Math.random() * 2, () => {
      if (kit.ended || finishing || kit.turnInFlight || kit.turnCount !== turnAtArm || deps.mic.recording) return;
      kit.event('silence');
    });
  }

  kit.onEvent = (ev: TurnEvent) => {
    if (ev.type === 'line' || ev.type === 'decision') heard++;
    switch (ev.type) {
      case 'heard':
        pickFromWords(ev.text);
        break;
      case 'decision':
        takeOver();
        applyMan(ev.man);
        if (ev.woman) applyWoman(ev.woman);
        kit.serverFear = ev.tension * 0.55;
        break;
      case 'line': {
        takeOver();
        cancelSilence?.();
        const seq = ++speechSeq;
        const npc = ev.speaker === 'man' ? man : ev.speaker === 'woman' ? woman : clerk;
        if (ev.speaker === 'clerk') {
          // The shopkeeper comes to his door.
          clerk.setBehaviour({ type: 'goTo', target: P.shopDoor, speed: 1.8, faceOnArrive: manPos });
          clerk.human.setEmotion('determined', 0.8);
          clerk.human.playGesture('point');
        }
        npc.human.setEmotion(ev.emotion, 0.85);
        // Lines queue behind each other so two people do not talk over one another.
        const prev = lastSpeech;
        lastSpeech = prev
          .then(() => (kit.ended ? undefined : kit.say(npc, ev.speaker, ev.text, ev.audioUrl)))
          .then(() => {
            if (seq === speechSeq) armSilenceTimer();
          });
        break;
      }
      case 'thought': {
        const { text, audioUrl } = ev;
        kit.after(0.8, () => !kit.ended && kit.thinkText(text, audioUrl, 0.5, true));
        break;
      }
      case 'outcome':
        void finish(ev.outcome);
        break;
      case 'done':
        // Arm after this turn has fully closed, or the in-flight check would always block it.
        if (dynamic) void lastSpeech.then(() => kit.after(0.15, () => kit.turnInFlight || armSilenceTimer()));
        break;
      default:
        break;
    }
  };

  kit.onKey = (code) => {
    if (kit.ended || finishing || (!started && code !== 'KeyF')) return;
    if (code === 'KeyF') {
      did('film');
      filming = !filming;
      player.setPhoneRaised(filming);
      hud.setFilming(filming);
      if (filming) audio.play('phone_camera_start', { volume: 0.6 });
      kit.event(filming ? 'filming_start' : 'filming_stop');
      if (filming) {
        // Something always answers the phone: if he has not noticed it, she has.
        const before = heard;
        kit.after(2.5, () => {
          if (!filming || kit.ended || finishing || heard !== before || womanGone) return;
          womanLooksUntil = kit.time + 2.5;
          kit.thinkText('Someone is filming this.', '', 0.4, true);
          hud.hint("He hasn't noticed the camera. Get closer, so he does.", 4000);
        });
      }
    } else if (code === 'KeyE') {
      if (clerk.distanceTo(player.position) < 4.2 || player.position.distanceTo(P.shopDoor) < 3) {
        hud.prompt(null);
        did('help');
        kit.event('asked_clerk');
      }
    }
  };

  /* ------------------------------------------------------------ endings */

  async function finish(outcome: OutcomeKind): Promise<void> {
    if (finishing) return;
    finishing = true;
    endTip();
    takeOver();
    cancelSilence?.();
    kit.speechEnabled = false;
    kit.refreshMic();
    hud.hint(null);
    hud.prompt(null);

    if (outcome === 'intervened_escalated' || outcome === 'no_intervention_escalated') {
      setLevel(6);
      if (outcome === 'no_intervention_escalated' && !manGone && !womanGone) {
        // Nobody stepped in: he grabs her arm, she screams, and it cuts straight to black.
        await Promise.race([lastSpeech, kit.wait(1.2)]);
        man.setBehaviour({ type: 'closeIn', target: womanPos, gap: 0.55, speed: 2.4 });
        man.human.setPosture('aggressive');
        man.human.playGesture('reach');
        woman.human.setEmotion('afraid', 1);
        woman.human.setPosture('cower');
        await kit.wait(0.75);
        audio.play('gasp', { volume: 0.7 });
        audio.speak(SCREAM_URL, { bus: 'voice', position: () => woman.position, volume: 1 });
        engine.pulse(1);
        await kit.wait(0.4);
        player.inputEnabled = false;
        await hud.fade(true, 0);
        await kit.wait(1.3);
        audio.cutToSilence();
      } else {
        await Promise.race([lastSpeech, kit.wait(2.5)]);
        if (outcome === 'intervened_escalated') player.flinch(man.position, 1);
        engine.pulse(1);
        await kit.wait(0.18);
        audio.cutToSilence();
        player.inputEnabled = false;
        await hud.fade(true, 60);
      }
      await kit.wait(4);
      await hud.card(
        'We stop here.',
        outcome === 'no_intervention_escalated' ? 'No one stepped in.' : 'What happens next is not shown.',
        6000,
      );
      kit.end(outcome);
      return;
    }

    if (outcome === 'exited') {
      kit.end(outcome);
      return;
    }

    if (outcome === 'no_intervention_she_escaped') {
      // She breaks past him and runs for her door. He lets her go, loudly.
      woman.human.setEmotion('afraid', 1);
      woman.setBehaviour({ type: 'leave', to: P.homeStoop, speed: 2.7 });
      man.setBehaviour({ type: 'idle', face: womanPos });
      man.human.setEmotion('contempt', 0.9);
      await kit.wait(0.9);
      man.human.playGesture('dismiss');
      await sayScripted(man, 'b_m6');
      await kit.wait(2.2);
    } else {
      // An intervention ended it. Give the moment after some room, and time to answer her if he has just gone.
      await Promise.race([lastSpeech, kit.wait(6)]);
      await kit.wait(2.4);
    }
    player.inputEnabled = false;
    await hud.fade(true, 2400);
    audio.stopAmbience(2);
    await kit.wait(1);
    kit.end(outcome);
  }

  /* ---------------------------------------------------- per-frame logic */

  kit.onFrame((dt) => {
    if (kit.ended || finishing) return;
    player.getEyePosition(eye);

    // Immersive: the open moment's options count when the player does them for real.
    if (open && mode === 'immersive') {
      const offers = (kind: Act['kind']) => open!.options.some((o) => o.act.kind === kind);
      if (deps.mic.recording) {
        // Speaking: nothing is picked yet. Wait to hear what she said, then pick the option that matches.
        if (offers('say') || offers('help')) holdForWords();
      } else if (awaitingWords) {
        // The server never answered with what it heard: let the moment carry on.
        if (performance.now() - awaitingSince > 10000) releaseWords();
      } else if (offers('look') && player.isLookingAt(woman.human.getHeadPosition(womanHead), 15)) {
        lookFor += dt;
        if (lookFor > 0.5) {
          did('look');
          catchHerEye();
        }
      }
    }

    if (!started && woman.distanceTo(man.position) < 7) startScript();
    if (!started) return;

    // gaze: he watches whoever he is focused on; she keeps her eyes down and ahead, or on whoever helped
    if (!manGone) {
      man.human.setGaze(manFocus === 'player' ? eye : woman.human.getHeadPosition(womanHead));
    }
    if (!womanGone) {
      if (manGone || kit.time < womanLooksUntil) woman.human.setGaze(eye);
      else if (woman.behaviour === 'idle' || woman.behaviour === 'backAway') woman.human.setGaze(man.human.getHeadPosition(manHead));
      else woman.human.setGaze(null);
    }

    // what the player does
    const dMan = manGone ? 99 : man.distanceTo(player.position);
    const dWoman = womanGone ? 99 : woman.distanceTo(player.position);
    if (Math.min(dMan, dWoman) < 3.5 && first('approached')) kit.event('approached');

    betweenFor = isBetween() ? betweenFor + dt : 0;
    if (betweenFor > 0.6 && first('between')) kit.event('stood_between');

    if (!dynamic && player.position.z < Math.min(man.position.z, woman.position.z) - 6 && first('passed')) {
      kit.event('walked_past');
    }

    // the shopkeeper can be asked for help
    const nearClerk = clerk.distanceTo(player.position) < 4.2 || player.position.distanceTo(P.shopDoor) < 3;
    if (nearClerk && !once.has('clerkAsked')) hud.prompt('E   Ask the shopkeeper for help');
    else hud.prompt(null);

    if (inRect(player.position, world.zones.homeEntrance) && first('leftScene')) kit.event('left_scene');
  });

  const prevOnKey = kit.onKey;
  kit.onKey = (code) => {
    if (code === 'KeyE' && (clerk.distanceTo(player.position) < 4.2 || player.position.distanceTo(P.shopDoor) < 3)) once.add('clerkAsked');
    prevOnKey(code);
  };

  // Webcam hands: look down and pinch for the phone (F); raise an open palm to ask the shopkeeper (E).
  const unbindHands = bindHandActions(deps, player, kit, {
    lookDownPinch: { key: 'KeyF', hint: () => (filming ? 'Pinch to put your phone away' : 'Pinch to take out your phone') },
    palm: {
      key: 'KeyE',
      hint: () => (!once.has('clerkAsked') && (clerk.distanceTo(player.position) < 4.2 || player.position.distanceTo(P.shopDoor) < 3) ? 'Raise an open hand to ask the shopkeeper for help' : null),
    },
  });

  kit.exposeDebug({ man, woman, clerk, world, mode: () => ({ started, dynamic, beat, manFocus, manGone, womanGone }) });

  /* ---------------------------------------------------------------- run */

  player.setPose(STAGE.player, 0);
  player.inputEnabled = false;
  player.requestLock();
  hud.setVisible(true);
  await hud.fade(true, 0);

  try {
    await kit.openSession();
  } catch (err) {
    console.error(err);
  }

  audio.startAmbience();
  audio.play('subway_rumble', { volume: 0.7 });
  await hud.card('Same street. Same night.', 'This time, you are a few steps behind her.', 4200);
  await hud.fade(false, 2000);
  player.inputEnabled = true;
  hud.objective(null);
  runKeyTutorial(kit, hud, 'bystander', { mode: deps.mode, phoneWalks: deps.phone?.status === 'connected' });
  woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.35 });
  setLevel(0);

  kit.after(26, () => {
    if (kit.ended) return;
    world.spawnPassingCar(-1);
    audio.play('car_pass', { position: new THREE.Vector3(0, 0.5, player.position.z - 12), volume: 0.6 });
  });

  const outcome = await kit.finished;
  const sessionId = kit.sessionId;
  endTip();
  hud.setLevel(null);
  window.removeEventListener('keydown', onDigit);
  await hud.fade(true, 400);
  player.setPhoneRaised(false);
  unbindHands();
  kit.dispose();
  player.dispose();
  return { sessionId, outcome };
}
