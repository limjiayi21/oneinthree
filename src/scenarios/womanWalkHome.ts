/**
 * Part 1: her walk home, in first person.
 * The director stages the street, reports what the player does to the Worker,
 * and turns the decision model's answers into his body, face and voice, and
 * into her involuntary reactions and inner thoughts.
 */
import { LEVELS } from '../../shared/levels';
import * as THREE from 'three';
import type { Gesture, Npc, Posture } from '../contracts';
import type { ManDecision, ManStance, OutcomeKind, TurnEvent } from '../../shared/types';
import { createPlayer } from '../player/player';
import { createHuman } from '../characters/human';
import { createNpc } from '../characters/npc';
import { SceneKit, clamp01, inRect, pick, pickSide, type SceneDeps, type SceneResult } from './common';
import { bindEchoSteps, laggedTarget } from './echoSteps';
import { LINE, walkCorridor } from '../world/layout';
import { runKeyTutorial } from './keyTutorial';
import { DOT_SECONDS, LOOK_GATE_TIMEOUT, LookGate, turnHint } from './lookGate';
import { createLookPrompt } from '../ui/lookPrompt';
import { SAFE_LIGHT_TRIGGER, createSafeLight } from '../world/safeLight';
import { createWayfinder, wayfinderLevel } from '../ui/wayfinder';
import { damp, forwardX, forwardZ, wrapAngle, yawOf } from '../player/mathx';
import { DEMO, demoCorridor } from './womanDemo';
import { SetPath } from './setPath';

const GESTURE_FOR: Partial<Record<ManStance, Gesture[]>> = {
  opening: ['beckon', 'wave'],
  persist: ['open_arms', 'beckon'],
  guilt: ['shrug', 'open_arms'],
  hostile: ['point', 'dismiss'],
  intimidate: ['lean_in', 'point'],
  back_off: ['hands_up', 'dismiss'],
};

const POSTURE_FOR: Partial<Record<ManStance, Posture>> = {
  idle: 'lean_wall',
  opening: 'relaxed',
  persist: 'relaxed',
  follow: 'relaxed',
  block: 'stand',
  guilt: 'relaxed',
  hostile: 'aggressive',
  intimidate: 'aggressive',
  back_off: 'stand',
};

export async function runWomanWalkHome(deps: SceneDeps): Promise<SceneResult> {
  const { engine, world, audio, hud } = deps;
  const P = world.points;
  const Z = world.zones;

  /** A short walk the game does for her (into the shop, up to her door): waypoints she walks through. */
  let guide: { points: THREE.Vector3[]; i: number; until: number } | null = null;
  // demo: while she walks, her feet follow the set path (start, the cat, him, the shop); she steps round him.
  const setPath = deps.demo ? new SetPath(DEMO.path, DEMO.pathXRange) : null;

  const player = createPlayer(engine, world, {
    body: 'woman',
    requireLock: deps.requireLock,
    eyes: deps.eyes,
    // The guided walk drives her own legs (steps, bob, collisions), the same way the phone does.
    extraMove: () => (guide ? { forward: 1, hurry: false } : (deps.phone?.move(performance.now()) ?? null)),
    moveYaw: () => (setPath && !guide ? setPath.heading(player.position, manInTheWay()) : null),
    // Only the walk home: this street, her building at the end, the shop if she needs it.
    // demo: only her sidewalk up to the shop, and the edges say nothing.
    corridor: deps.demo ? demoCorridor() : walkCorridor(P.subwayExit.z),
    onCorridorEdge: deps.demo
      ? undefined
      : (edge) =>
          hud.hint(edge === 'back' ? 'Home is the other way.' : edge === 'ahead' ? 'This is your building.' : 'Home is down this street.', 3000),
  });
  const kit = new SceneKit(deps, player, 'woman');

  /* ---------------------------------------------------------------- cast */

  const man: Npc = createNpc(
    createHuman({ build: 'man', height: 1.86, hairStyle: 'buzz', topStyle: 'hoodie', top: 0x2b2f38, bottom: 0x1d2330, shoes: 0x101010 }),
    engine.scene,
  );
  kit.addNpc(man, true);
  man.addAvoid({ getPosition: () => player.position, radius: 0.34 });
  // He starts leaning on the wall under the scaffolding, facing the street.
  man.setPose(deps.demo ? DEMO.manSpot : P.harasserSpot, Math.PI / 2); // demo: closer to the shop
  man.human.setPosture('lean_wall');
  man.human.setEmotion('neutral', 0.4);
  man.human.playGesture('check_phone');

  const clerk: Npc = createNpc(
    createHuman({ build: 'man', height: 1.72, hairStyle: 'short', topStyle: 'apron', top: 0x3d5a4c, bottom: 0x2a2a2e }),
    engine.scene,
  );
  kit.addNpc(clerk, false);
  clerk.setPose(P.clerkSpot, Math.PI / 2);

  // One other person on the block: across the street, headphones on, going the other way.
  const passer: Npc = createNpc(
    createHuman({ build: 'man', height: 1.78, hairStyle: 'beanie', topStyle: 'jacket', top: 0x4a4038, accessory: 'headphones' }),
    engine.scene,
  );
  kit.addNpc(passer, false);
  passer.setPose(P.passerbyA0, 0);
  passer.human.setVisible(false);

  /* --------------------------------------------------------------- state */

  let stance: ManStance = 'idle';
  let decision: ManDecision | null = null;
  let encounter = false; // he has engaged
  let manGone = false;
  /** Him, when he is close enough to be in her way (the set path steps round him). */
  function manInTheWay(): THREE.Vector3 | null {
    return !manGone && man.distanceTo(player.position) < 3 ? man.position : null;
  }
  /*
   * His block, in Part 1: he steps into her way and plants himself there, but does not shadow her sideways
   * steps, so she can always walk round him. Until this scene time he counts as blocking.
   */
  let blockingUntil = 0;
  const isBlocking = (): boolean => kit.time < blockingUntil;
  let manSpeaking: Promise<void> = Promise.resolve();
  let speechSeq = 0;
  let cancelSilence: (() => void) | null = null;
  let lastFlinch = -99;
  let lastGlance = -99;
  let lastBumpEvent = -99;
  let lastSpeedEvent = -99;
  let lastCrossEvent = -99;
  let fastFor = 0;
  let side: 'right' | 'left' | 'road' = 'right';
  let finishing = false;
  const once = new Set<string>();
  const first = (key: string) => (once.has(key) ? false : (once.add(key), true));
  const eye = new THREE.Vector3();
  const manHead = new THREE.Vector3();

  const startZ = deps.demo ? DEMO.start.z : P.subwayExit.z; // demo: she starts mid-block
  const progress = () => clamp01((startZ - player.position.z) / (startZ - P.homeStoop.z));

  kit.context = () => ({
    elapsed: kit.time,
    distanceToMan: manGone ? 99 : man.distanceTo(player.position),
    progress: progress(),
    playerSpeed: player.speed,
    facingMan: !manGone && player.isLookingAt(man.human.getHeadPosition(manHead), 35),
    manBlocking: isBlocking(),
    oppositeSidewalk: player.position.x < -4.5,
  });

  /* ------------------------------------------------- his body and voice */

  const toward = () => player.position;
  const towardFwd = () => player.getForward(new THREE.Vector3());
  const towardLagged = laggedTarget(kit, player);
  // With him behind her, his footsteps land just after hers (headphones make it spatial).
  bindEchoSteps({ deps, kit, player, npc: man, active: () => !manGone && man.behaviour === 'followBehind' });
  let farFromMan = true; // re-arms the snap glance once he has backed off

  function applyDecision(d: ManDecision): void {
    decision = d;
    const prev = stance;
    stance = d.stance;
    man.human.setEmotion(d.emotion, d.emotionIntensity);
    const posture = POSTURE_FOR[d.stance];
    if (posture) man.human.setPosture(posture);
    // demo: close. Every distance he keeps is tighter, but never under 0.8 m: their bodies touch at 0.64 m,
    // and he should crowd her, not pin her.
    const tight = deps.demo ? 0.85 : 1;
    const near = (floor: number) => Math.max(0.8, floor * tight);
    const quick = deps.demo ? 1.2 : 1;
    const gap = Math.max(0.8, d.proximity * tight);

    switch (d.action) {
      case 'stay':
        man.setBehaviour({ type: 'idle', face: toward });
        break;
      case 'approach':
        man.setBehaviour({ type: 'closeIn', target: toward, gap: Math.max(near(1.2), gap), speed: 1.7 * quick });
        break;
      case 'walk_alongside':
        man.setBehaviour({ type: 'walkAlongside', target: toward, targetForward: towardFwd, side: pickSide(player, gap), gap: Math.max(near(0.9), gap) });
        break;
      case 'follow_behind':
        // He follows where she was a beat ago: he reacts late, like someone matching her.
        man.setBehaviour({ type: 'followBehind', target: towardLagged, gap: Math.max(near(2.2), gap), speed: 2.4 * quick });
        break;
      case 'step_closer':
        man.setBehaviour({ type: 'closeIn', target: toward, gap: Math.max(near(0.75), gap), speed: 1.3 * quick });
        kit.after(0.5, () => involuntaryStepBack(0.55));
        break;
      case 'lean_in':
        man.setBehaviour({ type: 'closeIn', target: toward, gap: Math.max(near(0.75), gap), speed: 1.4 * quick });
        man.human.playGesture('lean_in');
        kit.after(0.45, () => involuntaryStepBack(0.5));
        break;
      case 'block_path': {
        // demo: by the shop he walks beside her instead, so the way in is always open.
        if (deps.demo && player.position.distanceTo(P.shopDoor) < 7) {
          man.setBehaviour({ type: 'walkAlongside', target: toward, targetForward: towardFwd, side: pickSide(player, near(0.9)), gap: near(0.9) });
          break;
        }
        // The spot just ahead of her, on the way she is going (the set path in the demo, else where she looks).
        const fy = setPath?.heading(player.position) ?? null;
        const dir = fy !== null ? new THREE.Vector3(forwardX(fy), 0, forwardZ(fy)) : towardFwd().setY(0).normalize();
        const spot = player.position.clone().addScaledVector(dir, Math.max(1.3, gap));
        man.setBehaviour({ type: 'goTo', target: spot, speed: 1.8 * quick, faceOnArrive: toward });
        const until = (blockingUntil = kit.time + (deps.demo ? 2.2 : 3.5));
        // Then he falls back beside her (unless a later block has taken over).
        kit.after(deps.demo ? 2.2 : 3.5, () => {
          if (kit.ended || finishing || blockingUntil !== until || man.behaviour !== 'goTo') return;
          man.setBehaviour({ type: 'walkAlongside', target: toward, targetForward: towardFwd, side: pickSide(player, near(0.9)), gap: near(0.9) });
        });
        kit.after(1.4, () => {
          if (stance === 'block' && !kit.ended && man.distanceTo(player.position) < 2.2 && kit.secondsSinceThought > 3.5) {
            kit.scare(0.1);
            kit.think(pick(['w_block_1', 'w_block_2']));
          }
        });
        break;
      }
      case 'back_away':
        man.setBehaviour({ type: 'backAway', from: toward, distance: 3.2, speed: 1.1 });
        break;
      case 'leave':
        leave();
        break;
      case 'grab':
        // Never shown: the arm starts to come up and the scene is cut by the outcome event.
        man.setBehaviour({ type: 'closeIn', target: toward, gap: 0.7, speed: 2.2 });
        man.human.playGesture('reach');
        break;
      default:
        break;
    }

    if (d.stance === 'gone' && prev !== 'gone') leave();
  }

  function leave(): void {
    if (manGone) return;
    manGone = true;
    cancelSilence?.();
    // He goes back the way she came, never past her toward her home.
    const away = player.position.z < man.position.z ? P.nearCorner : P.farCorner;
    man.human.setGaze(null);
    man.setBehaviour({ type: 'leave', to: away, speed: 1.5 });
    kit.serverFear = Math.min(kit.serverFear, 0.45);
    kit.after(2.2, () => !kit.ended && kit.think('w_left_1'));
    kit.after(7, () => !kit.ended && kit.think('w_left_2'));
    kit.after(4, () => (kit.serverFear = Math.min(kit.serverFear, 0.3)));
    hud.objective(deps.demo ? 'Get into the shop. It’s safe in there.' : 'Get home.'); // demo: the shop is the end of her street
  }

  function involuntaryStepBack(distance: number): void {
    if (kit.ended || manGone) return;
    if (man.distanceTo(player.position) > 1.5) return;
    player.stepBack(man.position, distance, 0.45);
    audio.play('cloth_rustle', { volume: 0.5 });
    kit.scare(0.18);
  }

  function armSilenceTimer(): void {
    cancelSilence?.();
    if (manGone || kit.ended || !encounter) return;
    const tension = decision ? clamp01(decision.emotionIntensity) : 0.4;
    const seconds = 7.5 - 3 * tension + Math.random() * 1.5;
    const turnAtArm = kit.turnCount;
    cancelSilence = kit.after(seconds, () => {
      if (kit.ended || manGone || kit.turnInFlight || kit.turnCount !== turnAtArm || deps.mic.recording) return;
      kit.event('silence');
    });
  }

  function onLine(text: string, url: string, speaker: 'man' | 'woman' | 'clerk', emotion: ManDecision['emotion']): void {
    const seq = ++speechSeq;
    cancelSilence?.();
    if (speaker === 'man') {
      audio.stopAllSpeech();
      man.human.setEmotion(emotion, decision?.emotionIntensity ?? 0.7);
      const g = GESTURE_FOR[stance];
      if (g && Math.random() < 0.8) man.human.playGesture(pick(g));
      // demo: she thinks of the shop early, once her reaction to his first line has landed (it comes at +0.9 s).
      if (deps.demo && first('shopThought')) kit.after(4, () => !kit.ended && !finishing && kit.think('w_shop'));
      manSpeaking = kit.say(man, 'man', text, url).then(() => {
        if (seq === speechSeq) armSilenceTimer();
      });
    } else if (speaker === 'clerk') {
      void kit.say(clerk, 'clerk', text, url);
    }
  }

  kit.onEvent = (ev: TurnEvent) => {
    switch (ev.type) {
      case 'decision':
        applyDecision(ev.man);
        kit.serverFear = ev.fear;
        if (typeof ev.man.level === 'number') {
          // He has walked off: the meter goes away with him.
          if (ev.man.stance === 'gone') kit.deps.hud.setLevel(null);
          else kit.deps.hud.setLevel(ev.man.level, LEVELS[ev.man.level]?.name ?? '');
        }
        break;
      case 'line':
        onLine(ev.text, ev.audioUrl, ev.speaker, ev.emotion);
        break;
      case 'thought': {
        // Her thought lands a beat after he starts speaking, as a reaction to it.
        const { text, audioUrl, fear } = ev;
        kit.after(0.9, () => !kit.ended && kit.thinkText(text, audioUrl, Math.max(fear, 0.2)));
        break;
      }
      case 'outcome':
        void finish(ev.outcome);
        break;
      case 'done':
        // A turn with no line (e.g. he only moved): keep the clock running.
        if (encounter && !manGone) void manSpeaking.then(() => kit.after(0.15, () => kit.turnInFlight || armSilenceTimer()));
        break;
      default:
        break;
    }
  };

  /** Where he waits, on the sidewalk just outside the shop door. */
  const SHOP_WAIT = new THREE.Vector3(P.shopDoor.x - 2.0, 0, P.shopDoor.z + 1.2);

  /** One answer to "is he still around?" for every scripted beat that mentions him. */
  function heIsHere(): boolean {
    return encounter && !manGone && stance !== 'gone' && man.distanceTo(player.position) < 25;
  }

  /* ------------------------------------------------------------ endings */

  async function finish(outcome: OutcomeKind): Promise<void> {
    if (finishing) return;
    finishing = true;
    cancelSilence?.();
    kit.speechEnabled = false;
    kit.refreshMic();
    hud.hint(null);

    if (outcome === 'escalated') {
      // Let the last thing he says land, then cut. Nothing is shown.
      await Promise.race([manSpeaking, kit.wait(2.5)]);
      player.flinch(man.position, 1);
      engine.pulse(1);
      await kit.wait(0.18);
      audio.cutToSilence();
      player.inputEnabled = false;
      await hud.fade(true, 60);
      await kit.wait(4.2);
      await hud.card('We stop here.', 'What happens next is not shown. For many women, it is not a simulation.', 6500);
      kit.end(outcome);
      return;
    }

    if (outcome === 'took_refuge') {
      audio.play('shop_bell', { position: P.shopDoor, volume: 0.9 });
      player.inputEnabled = false;
      kit.serverFear = Math.min(kit.serverFear, 0.5);
      // Only talk about him if he is actually out there: he may have walked off long before she came in.
      const present = heIsHere();
      if (present) {
        // He does not just vanish: he comes up to the door and waits outside for a moment, watching
        // (women describe men waiting outside a shop), before he gives up and walks off.
        man.setBehaviour({ type: 'goTo', target: SHOP_WAIT, speed: 1.6, faceOnArrive: () => P.shopDoor });
        man.human.setEmotion('annoyed', 0.75);
        man.human.setGaze(P.shopDoor.clone().setY(1.6));
      }
      clerk.human.setGaze(player.getEyePosition(eye));
      clerk.human.setEmotion(present ? 'worried' : 'neutral', present ? 0.7 : 0.4);
      await kit.wait(0.8);
      if (present) await kit.say(clerk, 'clerk', 'You okay, miss? That guy bothering you? Stay as long as you need.', '/audio/vo/c_refuge.mp3');
      else await kit.say(clerk, 'clerk', 'Evening. You alright, miss? Cold one tonight.', '/audio/vo/c_refuge_alone.mp3');
      kit.think(present ? 'w_refuge_1' : 'w_refuge_alone_1');
      if (deps.demo) {
        // demo: one thought, then out (no second thought, no parting shot from him).
        await kit.wait(2.2);
        await hud.fade(true, 1200);
        audio.stopAmbience(1.2);
        await kit.wait(0.6);
        kit.end(outcome);
        return;
      }
      await kit.wait(3.6);
      kit.think(present ? 'w_refuge_2' : 'w_refuge_alone_2');
      if (present) {
        // ... then a sour parting shot through the door, and he goes.
        await kit.wait(2.4);
        await kit.say(man, 'man', 'Whatever. Not worth it.', '/audio/vo/m_shop_sour.mp3');
        leave();
        await kit.wait(2.6);
      }
      await kit.wait(3.2);
      await hud.fade(true, 2200);
      audio.stopAmbience(2);
      await kit.wait(1.2);
      kit.end(outcome);
      return;
    }

    if (outcome === 'exited') {
      kit.end(outcome);
      return;
    }

    // Home: with him gone, or with him watching from the sidewalk.
    const followed = outcome === 'reached_home_followed';
    player.inputEnabled = false;
    audio.play('keys_jingle', { volume: 0.9 });
    await kit.wait(followed ? 0.7 : 1.1);
    audio.play('door_buzz_open', { position: P.homeDoor, volume: 0.8 });
    world.setDoorOpen('home', true);
    if (followed) {
      man.setBehaviour({ type: 'idle', face: toward });
      man.human.setEmotion('smirk', 0.8);
      player.glanceAt(man.human.getHeadPosition(manHead), 1.4, 0.75);
      await kit.wait(1.3);
    }
    await hud.fade(true, followed ? 500 : 900);
    audio.play('door_close_heavy', { volume: 1 });
    audio.setMuffle(1);
    audio.stopAmbience(1.5);
    await kit.wait(1.0);
    if (followed) {
      kit.thinkText('He watched me go in. He knows which door is mine.', '/audio/vo/w_home_followed.mp3', 0.8);
      await kit.wait(5);
    } else {
      audio.play('exhale_relief', { volume: 0.9 });
      kit.serverFear = Math.min(kit.serverFear, 0.25);
      await kit.wait(1.6);
      kit.think('w_home_1', { intensity: 0.2 });
      await kit.wait(2.8);
      kit.think('w_home_2', { intensity: 0.3 });
      await kit.wait(4.2);
    }
    kit.end(outcome);
  }

  /* ------------------------------------------------ street beats */

  /** The crash and the cat: she startles before she knows what it was. */
  /** `reactAfter`: seconds between the crash and her startle (so she reacts to the cat, not before it). */
  function alleyScare(crashAt: THREE.Vector3, catAt: THREE.Vector3, reactAfter = 0): void {
    audio.play('trash_can_crash', { position: crashAt, volume: 1 });
    kit.after(0.25, () => audio.play('cat_yowl', { position: catAt, volume: 0.9 }));
    const react = () => {
      if (kit.ended) return;
      player.startle(0.9);
      audio.play('gasp', { volume: 0.9 });
      kit.scare(0.75);
    };
    if (reactAfter > 0) kit.after(reactAfter, react);
    else react();
    kit.after(0.35 + reactAfter, () => kit.think('w_alley_1', { intensity: 0.95 }));
  }

  /** He looks up from his phone. That is all. It is enough. */
  function notice(thought: 'w_notice_1' | null): void {
    man.human.setGaze(player.getEyePosition(eye));
    man.human.setEmotion('smirk', 0.35);
    kit.serverFear = Math.max(kit.serverFear, 0.28);
    if (thought) kit.think(thought, { intensity: 0.35 });
  }

  /** demo: the crash, then he looks up. Once, from the timer or from how far she has walked. */
  function demoCrash(): void {
    if (kit.ended || finishing || !first('alley')) return;
    world.triggerCatDash(DEMO.catDash); // the alley's own cat is ~40 m behind her start
    // The crash is behind her; her head snaps round to the cat as it bolts across in front, and follows it to the curb.
    const crashAt = new THREE.Vector3(DEMO.crashX, DEMO.crashY, player.position.z + DEMO.crashBehind);
    const [, catFrom, , , catTo] = DEMO.catDash;
    alleyScare(crashAt, catFrom, DEMO.reactAfter);
    kit.after(DEMO.reactAfter, () => !kit.ended && player.glanceAt(catFrom.clone().setY(0.3), 0.7, 0.8));
    kit.after(DEMO.reactAfter + 0.45, () => !kit.ended && player.glanceAt(catTo.clone().setY(0.2), 1.2, 0.8));
    kit.after(DEMO.noticeDelay, () => {
      if (kit.ended || !first('notice')) return;
      // demo: she is already close, so the encounter starts at once and her first
      // thought comes from the model; a scripted one here would be cut off.
      notice(null);
    });
  }

  /* ---------------------------------------------------- per-frame logic */

  /* --------------------------------------------- the way to the shop */

  // A soft arrow toward the shop door, then in through it: faint going the right way, obvious going the wrong way.
  const way = createWayfinder();
  let wayLevel = 0;
  let wayApproach = 0;
  let wayDist = -1;
  function updateWay(dt: number): void {
    const pos = player.position;
    const inShop = pos.x > LINE - 0.3 && Math.abs(pos.z - P.shopDoor.z) < 5;
    if (!player.inputEnabled || inShop || dt <= 0) {
      way.hide();
      wayDist = -1;
      return;
    }
    const nearDoor = Math.hypot(P.shopDoor.x - pos.x, P.shopDoor.z - pos.z) < 1.6;
    const target = nearDoor ? P.shopInside : P.shopDoor;
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (wayDist >= 0) wayApproach = damp(wayApproach, (wayDist - dist) / dt, 4, dt);
    wayDist = dist;
    const relYaw = wrapAngle(yawOf(dx, dz) - player.yaw);
    // demo: once he has engaged, the way to safety is unmissable (strong, amber, labelled), not a subtle hint.
    const urgent = !!deps.demo && encounter;
    const wanted = Math.max(wayfinderLevel(relYaw, wayApproach), urgent ? 0.8 : 0);
    wayLevel = damp(wayLevel, wanted, 3, dt);
    // When the arrow is strong (she is facing or walking away), say which way: "Turn left" / "Turn right" / "Turn around".
    const turn = wayLevel > 0.55 ? turnHint(relYaw) : '';
    way.update(relYaw, wayLevel, urgent ? (turn ? `Shop · ${turn.toLowerCase()}` : 'Shop') : turn);
  }

  let tutorialEnds = 0; // scene time the controls tutorial finishes (set when she gains control)

  /*
   * Places of safety, marked with a circle of light: the shop (both versions) and her front door (full
   * version; the demo's street ends at the shop). Nothing there until he starts on her; then they light up
   * and pulse. Stepping into one and she walks in herself: to the doorway, through the middle of it, inside.
   */
  const shopLightAt = new THREE.Vector3(7.3, 0, P.shopDoor.z);
  const homeLightAt = new THREE.Vector3(P.homeStoop.x, 0, P.homeStoop.z);
  const shopLight = createSafeLight(engine.scene, shopLightAt);
  const homeLight = deps.demo ? null : createSafeLight(engine.scene, homeLightAt);
  const v3 = (x: number, z: number) => new THREE.Vector3(x, 0, z);
  const INTO_SHOP = [v3(7.4, P.shopDoor.z), v3(8.7, P.shopDoor.z), P.shopInside.clone()];
  const UP_TO_HOME = [P.homeStoop.clone(), P.homeDoor.clone()];
  // Its own frame step, so the lights and the guided walk carry on after an ending has begun at the threshold.
  kit.onFrame((dt) => {
    if (kit.ended) {
      guide = null;
      return;
    }
    const lit = encounter ? 1 : 0;
    shopLight.setStrength(lit);
    homeLight?.setStrength(lit);
    shopLight.update(dt);
    homeLight?.update(dt);
    if (!guide) return;
    const pos = player.position;
    let target = guide.points[guide.i]!;
    if (Math.hypot(target.x - pos.x, target.z - pos.z) < 0.3) {
      guide.i += 1;
      if (guide.i >= guide.points.length || kit.time > guide.until) {
        guide = null;
        return;
      }
      target = guide.points[guide.i]!;
    }
    if (kit.time > guide.until) {
      guide = null;
      return;
    }
    player.setLook(yawOf(target.x - pos.x, target.z - pos.z), 0);
  });
  const inLight = (pos: THREE.Vector3, at: THREE.Vector3) => Math.hypot(pos.x - at.x, pos.z - at.z) < SAFE_LIGHT_TRIGGER;

  kit.onFrame((dt) => {
    if (kit.ended || finishing) {
      way.hide();
      return;
    }
    updateWay(dt);
    const pos = player.position;
    player.getEyePosition(eye);

    // ambient beats on the way
    if (first('start') ) {
      // demo: no "Long day" line; the keys thought opens the scene instead (see the run section).
      if (!deps.demo) kit.after(1.6, () => kit.think('w_start_1', { intensity: 0.1 }));
    }
    if (!deps.demo && pos.z < P.subwayExit.z - 7 && first('keys')) {
      audio.play('keys_jingle', { volume: 0.5 });
      kit.think('w_keys', { intensity: 0.12 });
    }
    if (!deps.demo && pos.z < P.subwayExit.z - 13 && first('passer')) {
      passer.human.setVisible(true);
      passer.setBehaviour({ type: 'leave', to: P.passerbyA1, speed: 1.5 });
    }
    if (deps.demo && player.inputEnabled && pos.z < DEMO.crashByZ) demoCrash();
    if (!deps.demo && inRect(pos, Z.alleyTrigger) && first('alley')) {
      world.triggerAlleyEvent();
      alleyScare(P.alleySource, P.alleyMouth);
      kit.after(2.6, () => kit.think('w_alley_2', { intensity: 0.35 }));
    }
    if (!deps.demo && inRect(pos, Z.noticeTrigger) && first('notice')) {
      notice('w_notice_1');
      kit.after(3.4, () => !encounter && kit.think('w_notice_2', { intensity: 0.4 }));
      kit.after(6.8, () => !encounter && pos.x > 4.5 && kit.think('w_notice_cross', { intensity: 0.4 }));
    }

    // The encounter begins when she comes level with him, on either side of the street.
    if (!encounter && once.has('notice')) {
      const d = man.distanceTo(pos);
      if (d < 6.5 || pos.z < man.position.z + 3) {
        encounter = true;
        kit.speechEnabled = true;
        kit.refreshMic();
        hud.objective(deps.demo ? 'Get into the shop. It’s safe in there.' : 'Get home.');
        // demo: say it plainly once, after his first words have landed.
        if (deps.demo) kit.after(2.5, () => !kit.ended && !finishing && hud.hint('Get into the shop. It’s safe in there.', 5000));
        kit.event('begin');
        // After the controls tutorial if it is still running, so the two do not talk over each other.
        kit.after(Math.max(deps.demo ? 8 : 3.5, tutorialEnds - kit.time + 0.3), () => !kit.ended && hud.hint(deps.hands?.active ? 'Hold SPACE or hold up a fist to speak.  Or say nothing.' : 'Hold SPACE to speak.  Or say nothing.', 8000));
        // demo: if she stops to deal with him, point her at the way out once, so the demo cannot stall.
        if (deps.demo) kit.after(DEMO.nudgeAfter, () => !kit.ended && !finishing && hud.hint('The shop is still open.', 5000));
      }
    }

    if (encounter && !manGone) {
      man.human.setGaze(eye);
      const d = man.distanceTo(pos);

      // He keeps up with her. Decisions only arrive every few seconds; between them, a man who is still
      // engaged does not stand there while she walks off and then wander over later. Beside her while he
      // is talking (levels 0-3), trailing her once he is angry (4+). Leaving, backing off and the grab are
      // the model's call alone.
      const engaged = !['back_off', 'gone', 'escalate', 'idle'].includes(stance);
      // 'closeIn' holds once it arrives, so a woman who walks off during it is left behind as well.
      if (engaged && (man.behaviour === 'idle' || man.behaviour === 'closeIn') && !finishing) {
        const lvl = decision?.level ?? 1;
        const keep = ((lvl >= 4 ? 3.2 : 2.4) + (man.behaviour === 'closeIn' ? 0.8 : 0)) * (deps.demo ? 0.75 : 1); // demo: he lets her get less far
        if (d > keep && (player.speed > 0.4 || d > 4.5)) {
          if (lvl >= 4 || stance === 'follow') man.setBehaviour({ type: 'followBehind', target: towardLagged, gap: 2.4, speed: 2.4 });
          else man.setBehaviour({ type: 'walkAlongside', target: toward, targetForward: towardFwd, side: pickSide(player, 1.3), gap: 1.3 });
        }
      }

      // Her body reacts before she does.
      if (d < 0.95 && man.speed > 0.2 && kit.time - lastFlinch > 3.5) {
        lastFlinch = kit.time;
        player.flinch(man.position, 0.7);
        kit.scare(0.22);
        if (kit.secondsSinceThought > 4) kit.think(pick(['w_close_1', 'w_close_2', 'w_close_3']));
      }
      // He moves in close: her head snaps to his face before she decides to look.
      if (d > 2.8) farFromMan = true;
      else if (farFromMan && d < 2.0 && !player.isLookingAt(man.human.getHeadPosition(manHead), 25)) {
        farFromMan = false;
        lastGlance = kit.time;
        player.glanceAt(man.human.getHeadPosition(manHead), 0.75, 0.8);
      }
      // He is behind her and she is not looking: the glance she cannot stop herself taking.
      if (man.behaviour === 'followBehind' && d < 9 && kit.time - lastGlance > 11 && !player.isLookingAt(man.position, 60)) {
        lastGlance = kit.time;
        player.glanceAt(man.human.getHeadPosition(manHead), 1.1, 0.6);
        if (kit.secondsSinceThought > 5) kit.think(pick(['w_follow_1', 'w_follow_2']));
      }

      // What she does, reported to the model.
      const nowSide = pos.x > 4.5 ? 'right' : pos.x < -4.5 ? 'left' : 'road';
      if (nowSide !== 'road' && nowSide !== side) {
        side = nowSide;
        if (kit.time - lastCrossEvent > 8) {
          lastCrossEvent = kit.time;
          if (first('crossThought')) kit.think('w_cross');
          kit.event('crossed_street');
        }
      }
      fastFor = player.speed > 2.0 ? fastFor + dt : 0;
      if (fastFor > 1.4 && kit.time - lastSpeedEvent > 14) {
        lastSpeedEvent = kit.time;
        kit.event('sped_up');
      }

      // Nudges toward the choices a real woman would be weighing.
      if (!deps.demo && Math.abs(pos.z - P.shopDoor.z) < 9 && pos.x > 4.5 && first('shopThought') && kit.secondsSinceThought > 3) {
        kit.think('w_shop');
      }
      if (pos.z < P.homeStoop.z + 14 && d < 12 && first('homeNear') && kit.secondsSinceThought > 2.5) {
        kit.think('w_home_near', { intensity: 0.8 });
      }
      if (kit.time > 70 && first('nobody') && kit.secondsSinceThought > 4) kit.think('w_nobody');
    }

    // Scene-ending places.
    if (inRect(pos, Z.homeEntrance) && first('home')) {
      void kit.turn({ event: 'reached_home', ctx: kit.context() });
      // If the server is unreachable, still end the scene.
      kit.after(4, () => !finishing && void finish(manGone || !encounter ? 'reached_home_alone' : 'reached_home_followed'));
    }
    // Stepping into a lit circle (he has started on her) and she walks in by herself.
    if (!guide && encounter && player.inputEnabled) {
      if (inLight(pos, shopLightAt)) guide = { points: INTO_SHOP.map((p) => p.clone()), i: 0, until: kit.time + 6 };
      else if (homeLight && inLight(pos, homeLightAt)) guide = { points: UP_TO_HOME.map((p) => p.clone()), i: 0, until: kit.time + 6 };
    }
    if (encounter && inRect(pos, Z.shopEntrance) && first('shop')) {
      void kit.turn({ event: 'entered_shop', ctx: kit.context() });
      kit.after(4, () => !finishing && void finish('took_refuge'));
    }
  });

  const offBump = player.on('bumped', ({ collider }) => {
    if (collider !== man || manGone || !encounter) return;
    if (isBlocking() && kit.time - lastBumpEvent > 5) {
      lastBumpEvent = kit.time;
      kit.scare(0.12);
      kit.event('pushed_past');
    }
  });

  kit.exposeDebug({ man, clerk, world, stance: () => stance, decision: () => decision, applyDecision, log: [] as unknown[] });

  /* --------------------------------------------------------------- run */

  player.setPose(deps.demo ? DEMO.start : P.subwayExit, deps.demo ? DEMO.startYaw : 0);
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
  audio.play('subway_rumble', { volume: 0.8 });
  await hud.card('11:42 PM', 'Four blocks from home.', deps.demo ? 2500 : 3800); // demo: shorter
  world.spawnPassingCar(1);
  audio.play('car_pass', { position: new THREE.Vector3(0, 0.5, -20), volume: 0.7 });
  if (deps.demo) {
    // demo: the passer-by she would have seen further up the street, already on his way.
    passer.setPose(new THREE.Vector3(-6.35, 0, DEMO.start.z - 12), Math.PI);
    passer.human.setVisible(true);
    passer.setBehaviour({ type: 'leave', to: P.passerbyA1, speed: 1.5 });
    once.add('passer');
  }
  await hud.fade(false, deps.demo ? 1000 : 2200);
  player.inputEnabled = true;
  hud.objective('Walk home.');
  tutorialEnds = runKeyTutorial(kit, hud, 'woman', { mode: deps.mode, phoneWalks: deps.phone?.status === 'connected' });

  // Before walking, one instruction at a time, top middle: look at the dot (head look takes "straight
  // ahead" from there), then look left, then right, then walk. Walking unlocks anyway after
  // LOOK_GATE_TIMEOUT, so it can never stall. The demo's beats start from then.
  const lookPrompt = createLookPrompt();
  lookPrompt.show('dot');
  let gate: LookGate | null = null;
  let gateShown = 'dot';
  let unlockAt = Infinity;
  player.walkLocked = true;
  kit.after(DOT_SECONDS, () => {
    if (kit.ended) return;
    deps.recentreLook?.();
    // A moment for the head look to settle on its new centre before measuring the turns from it.
    kit.after(0.25, () => {
      gate = new LookGate(player.viewYaw);
      unlockAt = kit.time + LOOK_GATE_TIMEOUT;
    });
  });
  const offGate = kit.onFrame(() => {
    if (!player.walkLocked || kit.ended || !gate) return;
    const g = gate.update(player.viewYaw);
    if (gate.next !== gateShown) {
      gateShown = gate.next;
      lookPrompt.show(gate.next);
    }
    if (g.done || kit.time >= unlockAt) {
      player.walkLocked = false;
      lookPrompt.show('walk');
      kit.after(2.2, () => lookPrompt.dispose());
      onWalkUnlocked();
    }
  });
  void offGate;

  function onWalkUnlocked(): void {
    if (!deps.demo) return;
    // demo: a few calm seconds first. Keys, then the crash (sooner if she hurries: see onFrame).
    kit.after(DEMO.keysDelay, () => {
      if (kit.ended || !first('keys')) return;
      audio.play('keys_jingle', { volume: 0.5 });
      kit.think('w_keys', { intensity: 0.12 });
    });
    kit.after(DEMO.crashDelay, demoCrash);
  }

  // Life on the street, unrelated to her: a car now and then, a siren far off.
  const traffic = () => {
    if (kit.ended) return;
    const dir = Math.random() < 0.5 ? 1 : -1;
    world.spawnPassingCar(dir);
    audio.play('car_pass', { position: new THREE.Vector3(0, 0.5, player.position.z - 10 * dir), volume: 0.6 });
    kit.after(38 + Math.random() * 40, traffic);
  };
  kit.after(30 + Math.random() * 15, traffic);
  kit.after(48, () => !kit.ended && audio.play('distant_siren', { position: new THREE.Vector3(-60, 10, player.position.z - 80), volume: 0.5 }));

  const outcome = await kit.finished;
  const sessionId = kit.sessionId;
  offBump();
  await hud.fade(true, 400);
  way.dispose();
  shopLight.dispose();
  lookPrompt.dispose();
  homeLight?.dispose();
  kit.dispose();
  player.dispose();
  return { sessionId, outcome };
}
