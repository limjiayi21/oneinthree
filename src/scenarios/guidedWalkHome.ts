/**
 * The teaching replay of Part 2: the same street, cast and scripted beats,
 * frozen at the five moments in content/guided.json. Every moment follows the
 * same four beats:
 *
 *   1. Freeze  the scene clock stops and the screen dims (with a pool of light
 *              around one person where the moment asks for a spotlight)
 *   2. Choose  the prompt, the player's inner voice, three choices
 *   3. Play    the chosen lines and what the bodies do
 *   4. Name it a strip with the concept, one sentence, and a stat with its source
 *
 * Choices rated weaker or backfires play out, show their strip, then rewind to
 * the same moment. The replay never ends on a failure. Outcomes are fixed by
 * the file: no microphone, no live model, no decision-model rolls, no session.
 *
 * The camera is driven here (the player does not walk), so the whole replay
 * works from the keyboard alone, without pointer lock.
 */
import * as THREE from 'three';
import type { Npc } from '../contracts';
import type { Emotion } from '../../shared/types';
import {
  CONTINUES,
  conceptCitation,
  stripStatIds,
  type GuidedChoice,
  type GuidedData,
  type GuidedLine,
  type GuidedMoment,
} from '../../shared/content';
import guidedJson from '../../content/guided.json';
import { createPlayer } from '../player/player';
import { createHuman } from '../characters/human';
import { createNpc } from '../characters/npc';
import { yawOf } from '../player/mathx';
import { reducedMotion } from '../ui/dom';
import { bundledEvidence, resolveSources, resolveStats, safeUrl } from '../ui/evidence';
import { SCRIPT, SceneKit, voUrl, type SceneDeps } from './common';

export const GUIDED = guidedJson as unknown as GuidedData;

export interface GuidedResult {
  exited: boolean;
  /** The first choice picked at each moment, by moment id: e.g. { m1: 'm1_phone', m2: 'm2_my_business', ... }. */
  firstChoices: Record<string, string>;
}

class Exit extends Error {}

const estimate = (text: string) => Math.max(1.6, text.length * 0.062);
const v = (x: number, z: number) => new THREE.Vector3(x, 0, z);

/** Strip content for the HUD: the concept credit and stats resolved from evidence.json. */
function stripFor(choice: GuidedChoice, data: GuidedData) {
  const concept = choice.strip.conceptId ? data.concepts.find((c) => c.id === choice.strip.conceptId) : undefined;
  const stats = resolveStats(bundledEvidence, stripStatIds(choice.strip)).map((stat) => {
    const source = resolveSources(bundledEvidence, [stat.sourceId])[0];
    const name = source ? source.publisher || source.title : '';
    return {
      headline: stat.headline,
      text: stat.text,
      source: { label: source && Number.isFinite(source.year) ? `${name}, ${source.year}` : name, url: safeUrl(source?.url) ?? undefined },
    };
  });
  return {
    concept: choice.strip.concept,
    sentence: choice.strip.sentence,
    credit: concept ? { text: conceptCitation(concept), url: safeUrl(concept.url) ?? undefined } : undefined,
    stats,
  };
}

export async function runGuidedWalkHome(baseDeps: SceneDeps, data: GuidedData = GUIDED): Promise<GuidedResult> {
  // Never pointer lock here: nothing needs the mouse.
  const deps: SceneDeps = { ...baseDeps, requireLock: false };
  const { engine, world, audio, hud } = deps;
  const P = world.points;

  const player = createPlayer(engine, world, { body: 'bystander', requireLock: false });
  const kit = new SceneKit(deps, player, 'bystander');
  player.inputEnabled = false;

  /* ---------------------------------------------------------------- cast (as in Part 2) */

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

  /* --------------------------------------------------------------- state */

  let manGone = false;
  let manFocus: 'woman' | 'player' = 'woman';
  /** Before he calls out he is on his phone, glancing up at her. */
  let manOnPhone = true;
  let filming = false;
  let exited = false;
  let pausing = false;
  /** She looks round for help until this scene time. */
  let womanLooksUntil = -1;
  /** Aborts the open choice or strip when Esc is pressed, so the pause dialog can take focus. */
  let panelAbort: AbortController | null = null;

  const eye = new THREE.Vector3();
  const manHead = new THREE.Vector3();
  const womanHead = new THREE.Vector3();
  const clerkHead = new THREE.Vector3();
  const womanPos = () => woman.position;
  const manPos = () => man.position;
  const womanFwd = () => new THREE.Vector3(0, 0, -1);

  /* ------------------------------------------------------------- camera */

  // Where the player should stand and what they should look at. The camera eases toward both.
  // At the start the camera is out toward the curb, so he (against the wall ahead) is not lined up behind her
  // and not hidden by the stoops along the wall.
  const FOLLOW_FAR = { dx: -1.9, dz: 5.6 };
  const FOLLOW_CLOSE = { dx: -0.9, dz: 4.2 };
  let camGoal: () => THREE.Vector3 = () => v(woman.position.x + FOLLOW_FAR.dx, woman.position.z + FOLLOW_FAR.dz);
  let lookGoal: () => THREE.Vector3 = () => sceneLook();
  const camPos = new THREE.Vector3();
  let camYaw = 0;

  function sceneLook(): THREE.Vector3 {
    if (manGone || !man.human.root.visible) return woman.human.getHeadPosition(womanHead);
    return woman.human.getHeadPosition(womanHead).lerp(man.human.getHeadPosition(manHead), 0.5);
  }

  function placeCamera(pos: THREE.Vector3): void {
    camPos.copy(pos);
    const look = lookGoal();
    camYaw = yawOf(look.x - pos.x, look.z - pos.z);
    player.setPose(camPos, camYaw);
  }

  const follow = (gap: { dx: number; dz: number }) => {
    camGoal = () => v(woman.position.x + gap.dx, woman.position.z + gap.dz);
  };
  const holdHere = () => {
    const here = camPos.clone();
    camGoal = () => here;
  };
  const lookAtScene = () => {
    lookGoal = sceneLook;
  };

  // With reduced motion the camera cuts to each new position instead of gliding there.
  const still = reducedMotion();

  kit.onFrame((dt) => {
    // ease toward the goal; turn the short way round
    const goal = camGoal();
    if (still) camPos.copy(goal);
    else camPos.lerp(goal, 1 - Math.exp(-2.4 * dt));
    const look = lookGoal();
    const want = yawOf(look.x - camPos.x, look.z - camPos.z);
    let d = want - camYaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    camYaw += still ? d : d * (1 - Math.exp(-3.2 * dt));
    player.setPose(camPos, camYaw);

    player.getEyePosition(eye);
    if (!manGone) man.human.setGaze(manFocus === 'player' ? eye : manOnPhone ? null : woman.human.getHeadPosition(womanHead));
    if (manGone || kit.time < womanLooksUntil) woman.human.setGaze(eye);
    else if (woman.behaviour === 'idle' || woman.behaviour === 'backAway') woman.human.setGaze(man.human.getHeadPosition(manHead));
    else woman.human.setGaze(null);
  });

  /* --------------------------------------------------------- pause / exit */

  async function pauseFlow(): Promise<void> {
    if (pausing || exited) return;
    pausing = true;
    const wasPaused = kit.paused;
    kit.paused = true;
    audio.setMaster(0.25, 0.3);
    const choice = await hud.pause();
    audio.setMaster(1, 0.3);
    pausing = false;
    if (choice === 'exit') {
      exited = true;
      kit.paused = false;
      kit.end('exited');
      return;
    }
    kit.paused = wasPaused;
  }

  const onEsc = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.repeat || pausing || exited) return;
    e.preventDefault();
    if (panelAbort) panelAbort.abort();
    else void pauseFlow();
  };
  window.addEventListener('keydown', onEsc);

  /** Show a HUD panel; Esc aborts it into the pause dialog and then shows it again. */
  async function ask<T>(open: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (;;) {
      if (exited) throw new Exit();
      const ac = new AbortController();
      panelAbort = ac;
      try {
        return await open(ac.signal);
      } catch (err) {
        if (!ac.signal.aborted) throw err;
        await pauseFlow();
      } finally {
        if (panelAbort === ac) panelAbort = null;
      }
    }
  }

  /** Scene-time wait that stops the flow if the player leaves. */
  async function wait(seconds: number): Promise<void> {
    if (exited) throw new Exit();
    await Promise.race([kit.wait(seconds), kit.finished]);
    if (exited) throw new Exit();
  }

  async function step<T>(p: Promise<T>): Promise<T> {
    const r = await Promise.race([p, kit.finished.then(() => undefined as T)]);
    if (exited) throw new Exit();
    return r;
  }

  /** Scene-time wait until `done()` is true, or `limit` seconds have passed. */
  async function waitUntil(done: () => boolean, limit: number): Promise<void> {
    const t0 = kit.time;
    while (!done() && kit.time - t0 < limit) await wait(0.1);
  }

  /* ------------------------------------------------------- lines and bodies */

  const npcFor = (speaker: GuidedLine['speaker']): Npc | null => (speaker === 'man' ? man : speaker === 'woman' ? woman : speaker === 'clerk' ? clerk : null);

  async function sayScripted(npc: Npc, id: string): Promise<void> {
    const line = SCRIPT[id];
    if (!line) return;
    npc.human.setEmotion(line.emotion, 0.85);
    const speaker = line.speaker === 'woman' ? 'woman' : line.speaker === 'clerk' ? 'clerk' : 'man';
    await step(kit.say(npc, speaker, line.text, voUrl(id)));
  }

  let clerkLines = 0;
  async function playLine(line: GuidedLine): Promise<void> {
    const url = line.audioId ? voUrl(line.audioId) : '';
    switch (line.speaker) {
      case 'you':
        hud.subtitle('you', line.text, (estimate(line.text) + 1) * 1000);
        await wait(estimate(line.text));
        return;
      case 'self':
        // The player's own inner voice: a labelled subtitle, never her floating thought.
        hud.subtitle('self', line.text, (estimate(line.text) + 1) * 1000);
        await wait(estimate(line.text));
        return;
      case 'thought':
        kit.thinkText(line.text, url, 0.5, true);
        await wait(estimate(line.text));
        return;
      case 'clerk':
        clerkLines++;
        if (clerkLines === 1) {
          lookGoal = () => clerk.human.getHeadPosition(clerkHead);
        } else {
          // The shopkeeper comes to his door and calls out to him.
          clerk.setBehaviour({ type: 'goTo', target: P.shopDoor, speed: 1.8, faceOnArrive: manPos });
          clerk.human.setEmotion('determined', 0.8);
          clerk.human.playGesture('point');
          lookAtScene();
        }
        await step(kit.say(clerk, 'clerk', line.text, url));
        return;
      default: {
        const npc = npcFor(line.speaker)!;
        await step(kit.say(npc, line.speaker as 'man' | 'woman', line.text, url));
      }
    }
  }

  function manLeaves(): void {
    if (manGone) return;
    manGone = true;
    manFocus = 'woman';
    man.human.setGaze(null);
    man.human.setPosture('stand');
    man.human.playGesture('dismiss');
    // Down the street, away from the camera, so it reads as leaving.
    man.setBehaviour({ type: 'leave', to: P.farCorner, speed: 1.5 });
    kit.serverFear = Math.min(kit.serverFear, 0.12);
  }

  /** He spots her and calls out once she is close, as in Part 2's opening. */
  async function callOut(): Promise<void> {
    await waitUntil(() => woman.distanceTo(man.position) < 7, 30);
    manOnPhone = false;
    man.human.setPosture('relaxed');
    man.human.playGesture('beckon');
    man.setBehaviour({ type: 'idle', face: womanPos });
    woman.human.setEmotion('worried', 0.5);
    kit.serverFear = 0.12;
  }

  const MAN_BEFORE = new Set<GuidedChoice['manAction']>(['call_out', 'turn_on_player', 'close_in', 'block_path', 'walk_alongside', 'argue']);
  const WOMAN_BEFORE = new Set<GuidedChoice['womanAction']>(['freeze', 'step_back', 'hurry', 'keep_walking', 'look_around']);

  async function applyMan(action: GuidedChoice['manAction']): Promise<void> {
    if (action === 'none' || (manGone && action !== 'stay')) return;
    const emotion: Record<Exclude<GuidedChoice['manAction'], 'none'>, Emotion> = {
      stay: 'smirk',
      call_out: 'smirk',
      leave: 'sheepish',
      walk_alongside: 'smirk',
      block_path: 'annoyed',
      close_in: 'angry',
      turn_on_player: 'angry',
      argue: 'annoyed',
    };
    if (!manGone) man.human.setEmotion(emotion[action], 0.85);
    switch (action) {
      case 'stay':
        if (!manGone) man.setBehaviour({ type: 'idle', face: manFocus === 'player' ? () => player.position : womanPos });
        break;
      case 'call_out':
        await callOut();
        break;
      case 'leave':
        manLeaves();
        break;
      case 'walk_alongside':
        manOnPhone = false;
        man.human.setPosture('relaxed');
        man.setBehaviour({ type: 'walkAlongside', target: womanPos, targetForward: womanFwd, side: 'left', gap: 1.0 });
        break;
      case 'block_path':
        man.human.setPosture('relaxed');
        man.setBehaviour({ type: 'block', target: womanPos, targetForward: womanFwd, gap: 1.1 });
        woman.human.playGesture('clutch_bag');
        kit.serverFear = Math.max(kit.serverFear, 0.25);
        break;
      case 'close_in':
        man.human.setPosture('aggressive');
        man.human.playGesture('point');
        man.setBehaviour({ type: 'closeIn', target: womanPos, gap: 0.85, speed: 1.3 });
        kit.serverFear = Math.max(kit.serverFear, 0.38);
        break;
      case 'turn_on_player':
        manFocus = 'player';
        man.human.setPosture('aggressive');
        man.setBehaviour({ type: 'closeIn', target: () => player.position, gap: 1.4, speed: 1.6 });
        kit.scare(0.35);
        break;
      case 'argue':
        // He squares up to the player but stays where he is, between her and her way home.
        manFocus = 'player';
        man.human.playGesture('shrug');
        man.setBehaviour({ type: 'idle', face: () => player.position });
        break;
    }
  }

  function applyWoman(action: GuidedChoice['womanAction']): void {
    switch (action) {
      case 'none':
        break;
      case 'stay':
        woman.setBehaviour({ type: 'idle', face: manGone ? () => player.position : manPos });
        break;
      case 'keep_walking':
        woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.35 });
        break;
      case 'hurry':
        woman.human.setEmotion('afraid', 0.6);
        woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.85 });
        break;
      case 'look_around':
        // Still walking, she glances back down the street for anyone who might help.
        woman.human.setEmotion('afraid', 0.6);
        woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.6 });
        womanLooksUntil = kit.time + 2.2;
        break;
      case 'freeze':
        woman.human.setEmotion('afraid', 0.8);
        woman.human.setPosture('guarded');
        woman.setBehaviour({ type: 'idle', face: manGone ? () => player.position : manPos });
        break;
      case 'step_back':
        woman.human.setEmotion('afraid', 0.85);
        woman.human.setPosture('cower');
        woman.setBehaviour({ type: 'backAway', from: manGone ? () => player.position : manPos, distance: 1.0, speed: 1.0 });
        break;
      case 'move_to_player':
        woman.human.setEmotion('worried', 0.7);
        woman.setBehaviour({ type: 'closeIn', target: () => player.position, gap: 1.2, speed: 1.6 });
        break;
      case 'walk_home_alone':
        woman.human.setEmotion('worried', 0.7);
        woman.human.setPosture('guarded');
        woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.35 });
        break;
      case 'walk_with_player':
        woman.human.setEmotion('relieved', 0.7);
        woman.human.setPosture('stand');
        woman.setBehaviour({ type: 'closeIn', target: () => player.position, gap: 1.1, speed: 1.3 });
        break;
    }
  }

  function setFilming(on: boolean): void {
    if (filming === on) return;
    filming = on;
    player.setPhoneRaised(on);
    hud.setFilming(on);
    if (on) audio.play('phone_camera_start', { volume: 0.6 });
  }

  /** How the player moves for a choice. Returns what to undo once the lines are done. */
  async function movePlayer(choice: GuidedChoice): Promise<(() => Promise<void>) | null> {
    switch (choice.player) {
      case 'follow_close':
        follow(FOLLOW_CLOSE);
        lookAtScene();
        return null;
      case 'phone': {
        // Head down: you stop, and she walks on.
        holdHere();
        player.setPhoneRaised(true);
        // Eyes on the screen in your hand: the gaze drops to the pavement just ahead.
        const down = camPos.clone().add(new THREE.Vector3(-Math.sin(camYaw) * 0.9, 0.2, -Math.cos(camYaw) * 0.9));
        player.glanceAt(down, 5.5, 0.85);
        return async () => {
          player.setPhoneRaised(false);
          lookAtScene();
          await wait(1.4);
        };
      }
      case 'cross': {
        // Over to the far sidewalk, hanging back.
        const z = camPos.z;
        camGoal = () => v(-5.8, Math.max(z, woman.position.z + 9));
        lookAtScene();
        return null;
      }
      case 'hang_back':
        holdHere();
        lookAtScene();
        return null;
      case 'watch_clerk':
        // You look to the shop. He is behind the counter and does not move.
        holdHere();
        lookGoal = () => clerk.human.getHeadPosition(clerkHead);
        await wait(2.0);
        lookAtScene();
        return null;
      case 'to_her':
        // Walk up beside her, on the side away from him.
        camGoal = () => v(woman.position.x + 0.9, woman.position.z + 1.6);
        lookGoal = () => woman.human.getHeadPosition(womanHead);
        await wait(1.6);
        return null;
      case 'to_him':
        camGoal = () => v((woman.position.x + man.position.x) / 2 - 0.6, Math.max(woman.position.z, man.position.z) + 2.0);
        lookGoal = () => man.human.getHeadPosition(manHead);
        await wait(1.2);
        return null;
      case 'to_shop': {
        // Into the shop doorway, facing the shopkeeper.
        await step(hud.fade(true, 450));
        const door = P.shopDoor;
        lookGoal = () => clerk.human.getHeadPosition(clerkHead);
        placeCamera(v(door.x - 1.3, door.z + 1.4));
        holdHere();
        await step(hud.fade(false, 450));
        return null;
      }
      case 'film':
        holdHere();
        lookAtScene();
        setFilming(true);
        return null;
      default:
        holdHere();
        return null;
    }
  }

  /** Beat 3: play a choice out. Player movement, lines, and both bodies. */
  async function playChoice(choice: GuidedChoice): Promise<void> {
    clerkLines = 0;
    const undo = await movePlayer(choice);
    const manSpeaks = choice.lines.some((l) => l.speaker === 'man');
    const womanSpeaks = choice.lines.some((l) => l.speaker === 'woman');
    let manDone = false;
    let womanDone = false;
    const lastManIndex = choice.lines.map((l) => l.speaker).lastIndexOf('man');

    // Bodies with nothing to say react straight away.
    if (!womanSpeaks) {
      womanDone = true;
      applyWoman(choice.womanAction);
    }
    if (!manSpeaks) {
      manDone = true;
      await applyMan(choice.manAction);
    }

    for (let i = 0; i < choice.lines.length; i++) {
      const line = choice.lines[i]!;
      if (line.speaker === 'woman' && !womanDone && WOMAN_BEFORE.has(choice.womanAction)) {
        womanDone = true;
        applyWoman(choice.womanAction);
      }
      if (line.speaker === 'man' && !manDone && MAN_BEFORE.has(choice.manAction)) {
        manDone = true;
        await applyMan(choice.manAction);
      }
      await playLine(line);
      if (line.speaker === 'woman' && !womanDone) {
        womanDone = true;
        applyWoman(choice.womanAction);
      }
      if (i === lastManIndex && !manDone) {
        manDone = true;
        await applyMan(choice.manAction);
      }
      await wait(0.35);
    }
    if (undo) await undo();
    // When he walks off, let him get clear before the strip.
    await wait(choice.manAction === 'leave' ? 2.6 : choice.lines.length ? 1.2 : 1.6);
  }

  /* ----------------------------------------------------------- staging */

  interface Snapshot {
    man: THREE.Vector3;
    woman: THREE.Vector3;
    cam: THREE.Vector3;
  }
  const snapshots = new Map<string, Snapshot>();
  const snapshot = (id: string) => snapshots.set(id, { man: man.position.clone(), woman: woman.position.clone(), cam: camPos.clone() });

  function resetBodies(): void {
    kit.deps.audio.stopAllSpeech();
    hud.clearSubtitle();
    hud.thought('');
    setFilming(false);
    player.setPhoneRaised(false);
    manGone = false;
    manFocus = 'woman';
    womanLooksUntil = -1;
    man.human.setVisible(true);
    woman.human.setVisible(true);
    man.human.setPosture('relaxed');
    woman.human.setPosture('guarded');
    woman.human.setEmotion('worried', 0.5);
    clerk.setPose(P.clerkSpot, Math.PI / 2);
    clerk.setBehaviour({ type: 'idle' });
    clerk.human.setEmotion('neutral', 0.3);
    lookAtScene();
  }

  /** Moment 1: the start of Part 2. She walks; he is under the scaffolding on his phone. */
  async function stageStart(): Promise<void> {
    resetBodies();
    manOnPhone = true;
    man.setPose(P.harasserSpot, Math.PI / 2);
    man.setBehaviour({ type: 'idle' });
    man.human.setPosture('lean_wall');
    man.human.setEmotion('neutral', 0.3);
    man.human.playGesture('check_phone');
    woman.setPose(P.womanStartBystander, 0);
    woman.human.setEmotion('neutral', 0.3);
    follow(FOLLOW_FAR);
    lookAtScene();
    placeCamera(v(P.womanStartBystander.x + FOLLOW_FAR.dx, P.womanStartBystander.z + FOLLOW_FAR.dz));
    kit.serverFear = 0;
  }

  /**
   * Put everyone where the moment begins and play up to its freeze point.
   * `rewind` is true when coming back after a weaker choice.
   */
  async function stage(moment: GuidedMoment, rewind: boolean): Promise<void> {
    switch (moment.id) {
      case 'm1': {
        await stageStart();
        kit.paused = false;
        woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.35 });
        await wait(2.4);
        // He looks up from his phone and watches her come.
        man.human.setEmotion('smirk', 0.5);
        manOnPhone = false;
        await wait(1.4);
        return;
      }
      case 'm2': {
        if (rewind) {
          const s = snapshots.get('m2')!;
          resetBodies();
          manOnPhone = false;
          woman.setPose(s.woman, 0);
          man.setPose(s.man, yawOf(s.woman.x - s.man.x, s.woman.z - s.man.z));
          man.setBehaviour({ type: 'idle', face: womanPos });
          woman.human.setEmotion('worried', 0.5);
          follow(FOLLOW_CLOSE);
          placeCamera(s.cam);
          kit.serverFear = 0.12;
          kit.paused = false;
          woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.35 });
          await sayScripted(man, 'b_m1');
        }
        // Eyes down, a faster pace.
        woman.human.setEmotion('worried', 0.65);
        woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.6 });
        await wait(0.5);
        if (!rewind) snapshot('m2');
        return;
      }
      case 'm3': {
        if (rewind) {
          const s = snapshots.get('m3')!;
          resetBodies();
          manOnPhone = false;
          woman.setPose(s.woman, 0);
          man.setPose(s.man, 0);
          woman.human.setEmotion('worried', 0.6);
          follow(FOLLOW_CLOSE);
          placeCamera(s.cam);
          kit.serverFear = 0.15;
          kit.paused = false;
        }
        woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.5 });
        await applyMan('walk_alongside');
        if (!rewind) await wait(1.6);
        await sayScripted(man, 'b_m2');
        if (!rewind) snapshot('m3');
        return;
      }
      case 'm4': {
        resetBodies();
        manOnPhone = false;
        // He stands a little to the street side of her path, so from where you are he is beside her, not hidden behind her.
        const her = v(7.1, -66);
        const him = v(6.45, -66.9);
        const across = () => new THREE.Vector3(-0.6, 0, -0.8);
        woman.setPose(her, 0);
        man.setPose(him, Math.PI);
        woman.setBehaviour({ type: 'idle', face: manPos });
        man.setBehaviour({ type: 'block', target: womanPos, targetForward: across, gap: 1.1 });
        woman.human.setEmotion('afraid', 0.6);
        woman.human.playGesture('clutch_bag');
        // A few steps away: close enough to speak.
        camGoal = () => v(5.6, -62.6);
        placeCamera(v(5.6, -62.6));
        kit.serverFear = 0.25;
        kit.paused = false;
        await wait(0.4);
        man.human.playGesture('shrug');
        await sayScripted(man, 'b_m4');
        return;
      }
      default: {
        // He has gone. She has not moved yet.
        resetBodies();
        manGone = true;
        man.human.setVisible(false);
        man.setPose(P.nearCorner, 0);
        man.setBehaviour({ type: 'idle' });
        const her = v(6.6, -66);
        woman.setPose(her, Math.PI);
        woman.setBehaviour({ type: 'idle', face: () => player.position });
        woman.human.setEmotion('afraid', 0.55);
        woman.human.setPosture('guarded');
        lookGoal = () => woman.human.getHeadPosition(womanHead);
        camGoal = () => v(5.7, -62.6);
        placeCamera(v(5.7, -62.6));
        kit.serverFear = 0.1;
        kit.paused = false;
        await wait(0.8);
      }
    }
  }

  /* ------------------------------------------------------------- moments */

  /** Where a person's head is on screen, as fractions of the viewport; null if off screen. */
  function onScreen(npc: Npc): { x: number; y: number } | null {
    const p = npc.human.getHeadPosition(new THREE.Vector3());
    p.y -= 0.35; // centre the pool on the upper body, not the crown
    engine.camera.updateMatrixWorld();
    p.project(engine.camera);
    if (p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) return null;
    return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
  }

  /*
   * The choice panel goes in a side column, and the camera turns (while frozen)
   * just far enough that both people sit in the rest of the frame. SIDE_PANEL
   * mirrors the width of .oit-choice--side in src/ui/hud.css: min(26rem, 38vw) + 64px.
   */
  const SIDE_PANEL = (width: number) => Math.min(416, 0.38 * width) + 64;
  /** Below this width the panel stays along the bottom (as in hud.css). */
  const SIDE_MIN_WIDTH = 900;
  /** Clear space kept between the people and the panel, or the far edge, in NDC. */
  const MARGIN = 0.08;

  /** Left and right edges of everyone in view, in normalised device coordinates (-1..1). */
  function peopleSpan(): { min: number; max: number } | null {
    engine.camera.updateMatrixWorld();
    const people = [woman, ...(manGone || !man.human.root.visible ? [] : [man])];
    let min = Infinity;
    let max = -Infinity;
    const p = new THREE.Vector3();
    for (const npc of people) {
      const head = npc.human.getHeadPosition(p.clone());
      for (const point of [head, npc.position.clone().setY(0.05)]) {
        for (const dx of [-0.32, 0.32]) {
          // The body's width either side, across the view.
          const q = point.clone().add(new THREE.Vector3(Math.cos(camYaw) * dx, 0, -Math.sin(camYaw) * dx));
          q.project(engine.camera);
          if (q.z > 1) continue;
          min = Math.min(min, q.x);
          max = Math.max(max, q.x);
        }
      }
    }
    return Number.isFinite(min) ? { min, max } : null;
  }

  /** Turn the camera by `delta` radians of yaw while the scene clock is stopped. Eases unless motion is reduced. */
  async function turnWhileFrozen(delta: number): Promise<void> {
    const from = camYaw;
    const apply = (yaw: number) => {
      camYaw = yaw;
      player.setPose(camPos, camYaw);
      player.update(1e-4); // the controller only writes the camera on a positive step
    };
    if (still || Math.abs(delta) < 0.002) {
      apply(from + delta);
      return;
    }
    const ms = 420;
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const frame = () => {
        const k = Math.min(1, (performance.now() - t0) / ms);
        const e = 1 - Math.pow(1 - k, 3);
        apply(from + delta * e);
        if (k < 1 && !exited) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  /**
   * Pick the side for the panel and turn the camera so both people sit in the free part of the frame.
   * Returns where the panel goes.
   */
  async function frameForPanel(): Promise<'left' | 'right' | 'bottom'> {
    const width = window.innerWidth;
    if (width < SIDE_MIN_WIDTH) return 'bottom';
    const panel = (2 * SIDE_PANEL(width)) / width; // panel width in NDC
    const tanX = Math.tan(THREE.MathUtils.degToRad(engine.camera.fov / 2)) * engine.camera.aspect;
    const toAngle = (ndc: number) => Math.atan(ndc * tanX);

    const plan = (side: 'left' | 'right', span: { min: number; max: number }) => {
      const lo = side === 'left' ? -1 + panel + MARGIN : -1 + MARGIN;
      const hi = side === 'left' ? 1 - MARGIN : 1 - panel - MARGIN;
      const centre = (span.min + span.max) / 2;
      // Fits: move only as far as needed. Too wide: centre it in the free space.
      let target = centre;
      if (span.max - span.min > hi - lo) target = (lo + hi) / 2;
      else if (span.max > hi) target = centre - (span.max - hi);
      else if (span.min < lo) target = centre + (lo - span.min);
      // Turning right (yaw down) moves everything left on screen.
      return { side, centre, target, cost: Math.abs(toAngle(centre) - toAngle(target)) };
    };

    let span = peopleSpan();
    if (!span) return 'right';
    const options = [plan('right', span), plan('left', span)].sort((a, b) => a.cost - b.cost);
    const best = options[0]!;
    await turnWhileFrozen(-(toAngle(best.centre) - toAngle(best.target)));
    // One correction pass: the edges are not linear in angle.
    span = peopleSpan();
    if (span) {
      const again = plan(best.side, span);
      if (again.cost > 0.004) await turnWhileFrozen(-(toAngle(again.centre) - toAngle(again.target)));
    }
    return best.side;
  }

  /** Beat 1: stop the clock, make room for the panel, and dim the screen with a pool of light on the spotlit person. */
  async function freezeScene(moment: GuidedMoment): Promise<'left' | 'right' | 'bottom'> {
    kit.paused = true;
    const side = await frameForPanel();
    const who = moment.spotlight === 'woman' ? woman : moment.spotlight === 'man' ? man : null;
    const spot = who ? onScreen(who) : null;
    hud.freeze(spot ? { spot: { ...spot, r: 0.17 } } : {});
    return side;
  }

  const result: GuidedResult = { exited: false, firstChoices: {} };

  /** The four beats, rewinding until a choice that continues. The scene is already staged at the freeze point. */
  async function runMoment(moment: GuidedMoment): Promise<void> {
    const tried = new Set<string>();
    for (;;) {
      // 1. Freeze
      const side = await freezeScene(moment);
      // 2. Choose
      const index = await ask((signal) =>
        hud.choice({
          caption: moment.caption,
          prompt: moment.prompt,
          innerVoice: moment.innerVoice,
          options: moment.choices.map((c) => ({ label: c.text, note: tried.has(c.id) ? '(tried)' : undefined })),
          side,
          signal,
        }),
      );
      const choice = moment.choices[index]!;
      if (!(moment.id in result.firstChoices)) result.firstChoices[moment.id] = choice.id;
      tried.add(choice.id);

      // 3. Play it out
      hud.freeze(null);
      kit.paused = false;
      await playChoice(choice);

      // 4. Name it
      kit.paused = true;
      const goesOn = CONTINUES.has(choice.rating);
      const strip = stripFor(choice, data);
      await ask((signal) => hud.strip({ ...strip, action: goesOn ? 'Continue' : 'Back to the same moment', signal }));
      if (goesOn) return;

      // Rewind: over black, back to where the moment began.
      kit.paused = false;
      await step(hud.fade(true, 500));
      if (moment.lead) await step(hud.card(moment.lead, undefined, 2600));
      const restage = stage(moment, true);
      await step(hud.fade(false, 500));
      await restage;
    }
  }

  kit.exposeDebug({ man, woman, clerk, guided: () => ({ manGone, filming, result }) });

  /* ---------------------------------------------------------------- run */

  hud.setVisible(true);
  await hud.fade(true, 0);
  await stageStart();
  audio.startAmbience();

  try {
    await step(hud.card('Learn how to help', 'The same street again. It will stop at five moments and ask what you would do.', 3800));
    const fadeIn = step(hud.fade(false, 1200));

    // Dev only: ?moment=m4 or ?moment=m5 starts there (those two are staged from scratch), for checking framing.
    const startAt = import.meta.env.DEV ? new URLSearchParams(location.search).get('moment') : null;
    const first = startAt === 'm4' || startAt === 'm5' ? data.moments.findIndex((m) => m.id === startAt) : 0;
    const moments = data.moments;
    if (first > 0) await fadeIn;
    for (let i = Math.max(0, first); i < moments.length; i++) {
      const moment = moments[i]!;
      // m2 and m3 follow straight on from the moment before; the others start over black.
      const flows = moment.id === 'm2' || moment.id === 'm3';
      if (i === 0) {
        const staging = stage(moment, false);
        await fadeIn;
        await staging;
      } else if (flows) {
        kit.paused = false;
        await stage(moment, false);
      } else {
        kit.paused = false;
        await step(hud.fade(true, 700));
        if (moment.lead) await step(hud.card(moment.lead, undefined, 3600));
        const staging = stage(moment, false);
        await step(hud.fade(false, 700));
        await staging;
      }
      await runMoment(moment);
    }

    kit.paused = false;
    await step(hud.fade(true, 1600));
    audio.stopAmbience(2);
  } catch (err) {
    if (!(err instanceof Exit)) throw err;
  }

  result.exited = exited;
  window.removeEventListener('keydown', onEsc);
  // Set from closures, so the compiler cannot see it may be non-null here.
  (panelAbort as AbortController | null)?.abort();
  hud.freeze(null);
  await hud.fade(true, 300);
  setFilming(false);
  player.setPhoneRaised(false);
  kit.dispose();
  player.dispose();
  return result;
}
