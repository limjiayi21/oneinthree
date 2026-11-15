/**
 * Part 2: the same street, as a bystander twenty metres behind her.
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
import { walkCorridor } from '../world/layout';

export async function runBystanderWalkHome(deps: SceneDeps): Promise<SceneResult> {
  const { engine, world, audio, hud } = deps;
  const P = world.points;

  const player = createPlayer(engine, world, {
    body: 'bystander',
    requireLock: deps.requireLock,
    eyes: deps.eyes,
    extraMove: () => deps.phone?.move(performance.now()) ?? null,
    // Only this street, where it happens: not back the way you came, not off down a side street.
    corridor: walkCorridor(P.bystanderSpawn.z),
    onCorridorEdge: (edge) => hud.hint(edge === 'back' ? 'She went the other way.' : edge === 'ahead' ? 'The street ends here.' : 'Stay on this street.', 3000),
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

  man.setPose(P.harasserSpot, Math.PI / 2);
  man.human.setPosture('lean_wall');
  man.human.playGesture('check_phone');
  woman.setPose(P.womanStartBystander, 0);
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
      man.human.setPosture('relaxed');
      man.human.setGaze(woman.human.getHeadPosition(womanHead));
      man.human.playGesture('beckon');
      void sayScripted(man, 'b_m1');
      woman.human.setEmotion('worried', 0.5);
      kit.serverFear = 0.12;
    });
    at(1.9, 'call_out', () => herThought('b_t1'));
    at(3.6, 'alongside', () => {
      man.setBehaviour({ type: 'walkAlongside', target: womanPos, targetForward: womanFwd, side: 'left', gap: 1.0 });
    });
    at(5.6, 'alongside', () => void sayScripted(man, 'b_m2'));
    at(9.2, 'deflect', () => void sayScripted(woman, 'b_w1'));
    at(10.8, 'deflect', () => kit.think('s_1', { intensity: 0.15 }));
    at(13.2, 'walk_you_home', () => {
      man.human.playGesture('open_arms');
      void sayScripted(man, 'b_m3');
      woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.85 });
      woman.human.setEmotion('afraid', 0.55);
      kit.serverFear = 0.2;
    });
    at(15.8, 'walk_you_home', () => herThought('b_t2'));
    at(17.4, 'walk_you_home', () => kit.think('s_2', { intensity: 0.15 }));
    at(19.2, 'blocks', () => {
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
    at(27.6, 'pleads', () => kit.think('s_3', { intensity: 0.25 }));
    at(29.4, 'hostile', () => {
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
    at(36.6, 'hostile', () => kit.think('s_4', { intensity: 0.35 }));
    at(39.4, 'hostile', () => herThought('b_t4'));
    at(43.5, 'timeout', () => void kit.turn({ event: 'scene_timeout', ctx: kit.context() }));
    // If the server never answers, she still gets away, as most do.
    at(49, 'timeout', () => void finish('no_intervention_she_escaped'));
  }

  function takeOver(): void {
    if (dynamic) return;
    dynamic = true;
    for (const c of beatCancels.splice(0)) c();
    beat = 'intervention';
  }

  /* ------------------------------------------------- model-driven scene */

  function applyMan(d: ManDecision): void {
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
    switch (ev.type) {
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
    if (kit.ended || finishing || !started) return;
    if (code === 'KeyF') {
      filming = !filming;
      player.setPhoneRaised(filming);
      hud.setFilming(filming);
      if (filming) audio.play('phone_camera_start', { volume: 0.6 });
      kit.event(filming ? 'filming_start' : 'filming_stop');
    } else if (code === 'KeyE') {
      if (clerk.distanceTo(player.position) < 4.2 || player.position.distanceTo(P.shopDoor) < 3) {
        hud.prompt(null);
        kit.event('asked_clerk');
      }
    }
  };

  /* ------------------------------------------------------------ endings */

  async function finish(outcome: OutcomeKind): Promise<void> {
    if (finishing) return;
    finishing = true;
    takeOver();
    cancelSilence?.();
    kit.speechEnabled = false;
    kit.refreshMic();
    hud.hint(null);
    hud.prompt(null);

    if (outcome === 'intervened_escalated' || outcome === 'no_intervention_escalated') {
      await Promise.race([lastSpeech, kit.wait(2.5)]);
      if (outcome === 'intervened_escalated') player.flinch(man.position, 1);
      engine.pulse(1);
      await kit.wait(0.18);
      audio.cutToSilence();
      player.inputEnabled = false;
      await hud.fade(true, 60);
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
      // An intervention ended it. Give the moment after some room.
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

    if (!started && woman.distanceTo(man.position) < 7) startScript();
    if (!started) return;

    // gaze: he watches whoever he is focused on; she keeps her eyes down and ahead, or on whoever helped
    if (!manGone) {
      man.human.setGaze(manFocus === 'player' ? eye : woman.human.getHeadPosition(womanHead));
    }
    if (!womanGone) {
      if (manGone) woman.human.setGaze(eye);
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

  player.setPose(P.bystanderSpawn, 0);
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
  await hud.card('Same street. Same night.', 'This time, you are twenty metres behind her.', 4200);
  await hud.fade(false, 2000);
  player.inputEnabled = true;
  hud.objective(null);
  woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.35 });
  kit.after(2.5, () => hud.hint('SPACE speak  ·  F film  ·  E interact  ·  or keep walking', 9000));

  kit.after(26, () => {
    if (kit.ended) return;
    world.spawnPassingCar(-1);
    audio.play('car_pass', { position: new THREE.Vector3(0, 0.5, player.position.z - 12), volume: 0.6 });
  });

  const outcome = await kit.finished;
  const sessionId = kit.sessionId;
  await hud.fade(true, 400);
  player.setPhoneRaised(false);
  unbindHands();
  kit.dispose();
  player.dispose();
  return { sessionId, outcome };
}
