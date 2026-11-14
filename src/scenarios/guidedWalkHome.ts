/**
 * Guided replay of Part 2: the same street, the same cast and the same
 * scripted beats, but the scene freezes at three moments and asks what the
 * player would do. Outcomes are fixed by content/guided.json: no microphone,
 * no live model, no decision-model rolls, and no session on the server.
 *
 * A choice that is not the best one plays its short consequence, shows one
 * line of feedback, and rewinds to the same moment. The replay never ends on
 * a failure. The camera is driven here (the player does not walk), so the
 * whole thing works from the keyboard alone, without pointer lock.
 */
import * as THREE from 'three';
import type { Npc } from '../contracts';
import type { Emotion } from '../../shared/types';
import type { GuidedChoice, GuidedData, GuidedLine, GuidedMoment } from '../../shared/content';
import guidedJson from '../../content/guided.json';
import { createPlayer } from '../player/player';
import { createHuman } from '../characters/human';
import { createNpc } from '../characters/npc';
import { yawOf } from '../player/mathx';
import { reducedMotion } from '../ui/dom';
import { SCRIPT, SceneKit, voUrl, type SceneDeps } from './common';

export const GUIDED = guidedJson as unknown as GuidedData;

export interface GuidedResult {
  exited: boolean;
  /** The first choice picked at each moment, by moment id: e.g. { m1: 'm1_wait', m2: 'm2_delegate', m3: 'm3_delay' }. */
  firstChoices: Record<string, string>;
  /** The best choices, in order, for the end screen. */
  used: Array<{ name: string; what: string }>;
}

class Exit extends Error {}

const estimate = (text: string) => Math.max(1.6, text.length * 0.062);
const v = (x: number, z: number) => new THREE.Vector3(x, 0, z);

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
  let filming = false;
  let exited = false;
  let pausing = false;
  /** Aborts the open choice / feedback panel when Esc is pressed, so the pause dialog can take focus. */
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
  let camGoal: () => THREE.Vector3 = () => v(woman.position.x - 1.0, woman.position.z + 4.6);
  let lookGoal: () => THREE.Vector3 = () =>
    manGone ? woman.human.getHeadPosition(womanHead) : woman.human.getHeadPosition(womanHead).lerp(man.human.getHeadPosition(manHead), 0.5);
  const camPos = new THREE.Vector3();
  let camYaw = 0;

  function placeCamera(pos: THREE.Vector3): void {
    camPos.copy(pos);
    const look = lookGoal();
    camYaw = yawOf(look.x - pos.x, look.z - pos.z);
    player.setPose(camPos, camYaw);
  }

  const follow = () => {
    camGoal = () => v(woman.position.x - 1.0, woman.position.z + 4.6);
  };
  const holdHere = () => {
    const here = camPos.clone();
    camGoal = () => here;
  };
  const lookAtScene = () => {
    lookGoal = () =>
      manGone || !man.human.root.visible
        ? woman.human.getHeadPosition(womanHead)
        : woman.human.getHeadPosition(womanHead).lerp(man.human.getHeadPosition(manHead), 0.5);
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
    if (!manGone) man.human.setGaze(manFocus === 'player' ? eye : woman.human.getHeadPosition(womanHead));
    if (manGone) woman.human.setGaze(eye);
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
        kit.thinkText(line.text, '', 0.15);
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

  const MAN_BEFORE = new Set(['turn_on_player', 'close_in', 'block_path', 'walk_alongside']);
  const WOMAN_BEFORE = new Set(['freeze', 'step_back', 'hurry']);

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

  async function applyMan(action: GuidedChoice['manAction']): Promise<void> {
    if (manGone && action !== 'stay') return;
    const emotion: Record<GuidedChoice['manAction'], Emotion> = {
      stay: 'smirk',
      leave: 'sheepish',
      walk_alongside: 'smirk',
      block_path: 'annoyed',
      close_in: 'angry',
      turn_on_player: 'angry',
      glare_then_leave: 'angry',
    };
    if (!manGone) man.human.setEmotion(emotion[action], 0.85);
    switch (action) {
      case 'stay':
        if (!manGone) man.setBehaviour({ type: 'idle', face: manFocus === 'player' ? () => player.position : womanPos });
        break;
      case 'leave':
        manLeaves();
        break;
      case 'walk_alongside':
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
      case 'glare_then_leave':
        manFocus = 'player';
        man.setBehaviour({ type: 'idle', face: () => player.position });
        await wait(1.3);
        manLeaves();
        break;
    }
  }

  function applyWoman(action: GuidedChoice['womanAction']): void {
    switch (action) {
      case 'stay':
        woman.setBehaviour({ type: 'idle', face: manGone ? () => player.position : manPos });
        break;
      case 'keep_walking':
        woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.35 });
        break;
      case 'hurry':
        woman.human.setEmotion('afraid', 0.6);
        woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.9 });
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

  /** How the player moves for a choice, from what it is. */
  async function movePlayer(choice: GuidedChoice): Promise<void> {
    if (choice.filming) {
      if (manGone) holdHere();
      else {
        // Across the road, out of reach and out of it.
        const z = woman.position.z + 3.5;
        camGoal = () => v(-5.8, z);
        await wait(2.2);
      }
      setFilming(true);
      return;
    }
    switch (choice.tactic) {
      case 'Distract':
      case 'Delay':
        // Walk up beside her, on the side away from him.
        camGoal = () => v(woman.position.x + 0.9, woman.position.z + 1.6);
        lookGoal = () => woman.human.getHeadPosition(womanHead);
        await wait(1.6);
        return;
      case 'Direct':
        camGoal = () => v((woman.position.x + man.position.x) / 2 - 0.6, Math.max(woman.position.z, man.position.z) + 2.0);
        lookGoal = () => man.human.getHeadPosition(manHead);
        await wait(1.6);
        return;
      case 'Delegate': {
        // Into the shop doorway, facing the shopkeeper.
        await step(hud.fade(true, 450));
        const door = P.shopDoor;
        lookGoal = () => clerk.human.getHeadPosition(clerkHead);
        placeCamera(v(door.x - 1.3, door.z + 1.4));
        holdHere();
        await step(hud.fade(false, 450));
        return;
      }
      default:
        holdHere();
        return;
    }
  }

  /** Play a choice's consequence: player movement, lines, and both bodies. */
  async function playChoice(choice: GuidedChoice): Promise<void> {
    kit.paused = false;
    clerkLines = 0;
    await movePlayer(choice);
    const manSpeaks = choice.lines.some((l) => l.speaker === 'man');
    const womanSpeaks = choice.lines.some((l) => l.speaker === 'woman');
    let manDone = false;
    let womanDone = false;
    const lastManIndex = choice.lines.map((l) => l.speaker).lastIndexOf('man');

    for (let i = 0; i < choice.lines.length; i++) {
      const line = choice.lines[i]!;
      if (line.speaker === 'man' && !manDone && MAN_BEFORE.has(choice.manAction)) {
        manDone = true;
        void applyMan(choice.manAction).catch(() => undefined);
      }
      if (line.speaker === 'woman' && !womanDone && WOMAN_BEFORE.has(choice.womanAction)) {
        womanDone = true;
        applyWoman(choice.womanAction);
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
      // Bodies that have nothing to say still react, after the first line.
      if (i === 0 && !womanSpeaks && !womanDone) {
        womanDone = true;
        applyWoman(choice.womanAction);
      }
      if (i === 0 && !manSpeaks && !manDone) {
        manDone = true;
        await applyMan(choice.manAction);
      }
      await wait(0.35);
    }
    // When he walks off, let him get clear before the feedback.
    await wait(choice.manAction === 'leave' || choice.manAction === 'glare_then_leave' ? 2.8 : 1.4);
  }

  /* ----------------------------------------------------------- staging */

  interface Snapshot {
    man: THREE.Vector3;
    woman: THREE.Vector3;
    cam: THREE.Vector3;
  }
  const snapshots = new Map<string, Snapshot>();

  function resetBodies(): void {
    kit.deps.audio.stopAllSpeech();
    hud.clearSubtitle();
    setFilming(false);
    manGone = false;
    manFocus = 'woman';
    man.human.setVisible(true);
    woman.human.setVisible(true);
    man.human.setPosture('relaxed');
    woman.human.setPosture('guarded');
    clerk.setPose(P.clerkSpot, Math.PI / 2);
    clerk.setBehaviour({ type: 'idle' });
    clerk.human.setEmotion('neutral', 0.3);
    lookAtScene();
  }

  /** Put everyone where the moment begins, then play its lead-in line. */
  async function stage(moment: GuidedMoment): Promise<void> {
    resetBodies();
    if (moment.id === 'm1') {
      const s = snapshots.get('m1')!;
      woman.setPose(s.woman, 0);
      man.setPose(s.man, yawOf(s.woman.x - s.man.x, s.woman.z - s.man.z));
      woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.35 });
      man.setBehaviour({ type: 'walkAlongside', target: womanPos, targetForward: womanFwd, side: 'left', gap: 1.0 });
      woman.human.setEmotion('worried', 0.5);
      follow();
      placeCamera(s.cam);
      kit.serverFear = 0.12;
      kit.paused = false;
      await sayScripted(man, 'b_m2');
    } else if (moment.id === 'm2') {
      const her = v(6.6, -66);
      const him = v(6.5, -67.2);
      woman.setPose(her, 0);
      man.setPose(him, Math.PI);
      woman.setBehaviour({ type: 'idle', face: manPos });
      man.setBehaviour({ type: 'block', target: womanPos, targetForward: womanFwd, gap: 1.1 });
      woman.human.setEmotion('afraid', 0.6);
      woman.human.playGesture('clutch_bag');
      camGoal = () => v(5.4, -61);
      placeCamera(v(5.4, -61));
      kit.serverFear = 0.25;
      kit.paused = false;
      await wait(0.4);
      man.human.playGesture('shrug');
      await sayScripted(man, 'b_m4');
    } else {
      // He has gone. She has not moved yet.
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

  /** First pass through Part 2's opening, up to "I'm talking to you", as scripted in bystanderWalkHome.ts. */
  async function playOpening(): Promise<void> {
    while (woman.distanceTo(man.position) >= 7) await wait(0.1);
    man.human.setPosture('relaxed');
    man.human.setGaze(woman.human.getHeadPosition(womanHead));
    man.human.playGesture('beckon');
    woman.human.setEmotion('worried', 0.5);
    kit.serverFear = 0.12;
    const callOut = sayScripted(man, 'b_m1');
    await wait(1.9);
    kit.think('b_t1', { quiet: true, intensity: 0.5 });
    await wait(1.7);
    man.setBehaviour({ type: 'walkAlongside', target: womanPos, targetForward: womanFwd, side: 'left', gap: 1.0 });
    await wait(2.0);
    await callOut;
    await sayScripted(man, 'b_m2');
    snapshots.set('m1', { man: man.position.clone(), woman: woman.position.clone(), cam: camPos.clone() });
  }

  /* ------------------------------------------------------------- moments */

  const result: GuidedResult = { exited: false, firstChoices: {}, used: [] };

  /** Ask, play the consequence, give feedback; rewind until the best choice. The scene is already staged. */
  async function runMoment(moment: GuidedMoment): Promise<void> {
    const tried = new Set<string>();
    for (;;) {
      kit.paused = true;
      const index = await ask((signal) =>
        hud.choice({
          prompt: moment.prompt,
          options: moment.choices.map((c) => ({ label: c.text, note: tried.has(c.id) ? '(tried)' : undefined })),
          signal,
        }),
      );
      const choice = moment.choices[index]!;
      if (!(moment.id in result.firstChoices)) result.firstChoices[moment.id] = choice.id;
      tried.add(choice.id);

      await playChoice(choice);
      kit.paused = true;
      const best = choice.rating === 'best';
      await ask((signal) =>
        hud.feedback({
          text: choice.feedback,
          action: best ? 'Continue' : 'Back to the same moment',
          signal,
        }),
      );
      if (best) {
        result.used.push({ name: choice.tactic, what: choice.text });
        return;
      }
      // Rewind: over black, back to where the moment began.
      kit.paused = false;
      await step(hud.fade(true, 500));
      await stage(moment);
      await step(hud.fade(false, 500));
    }
  }

  kit.exposeDebug({ man, woman, clerk, guided: () => ({ manGone, filming, result }) });

  /* ---------------------------------------------------------------- run */

  man.setPose(P.harasserSpot, Math.PI / 2);
  man.human.setPosture('lean_wall');
  man.human.playGesture('check_phone');
  woman.setPose(P.womanStartBystander, 0);
  woman.human.setPosture('guarded');
  woman.human.setEmotion('neutral', 0.3);
  clerk.setPose(P.clerkSpot, Math.PI / 2);
  placeCamera(v(P.womanStartBystander.x - 1.1, P.womanStartBystander.z + 6));

  hud.setVisible(true);
  await hud.fade(true, 0);
  audio.startAmbience();

  try {
    await step(hud.card('Guided replay', 'The same moment again. This time it will stop and ask what you would do.', 3800));
    await step(hud.fade(false, 1600));
    woman.setBehaviour({ type: 'goTo', target: P.homeStoop, speed: 1.35 });
    await playOpening();

    const moments = data.moments;
    for (let i = 0; i < moments.length; i++) {
      const moment = moments[i]!;
      if (i === 0) {
        await runMoment(moment);
        continue;
      }
      // A moment the script cannot reach from the last one starts over black, with a line saying so.
      kit.paused = false;
      await step(hud.fade(true, 700));
      if (moment.lead) await step(hud.card(moment.lead, undefined, 3600));
      await stage(moment);
      await step(hud.fade(false, 700));
      await runMoment(moment);
    }

    kit.paused = false;
    await step(hud.fade(true, 1800));
    audio.stopAmbience(2);
  } catch (err) {
    if (!(err instanceof Exit)) throw err;
  }

  result.exited = exited;
  window.removeEventListener('keydown', onEsc);
  // Set from closures, so the compiler cannot see it may be non-null here.
  (panelAbort as AbortController | null)?.abort();
  await hud.fade(true, 300);
  setFilming(false);
  player.setPhoneRaised(false);
  kit.dispose();
  player.dispose();
  return result;
}
