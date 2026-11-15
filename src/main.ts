import { createEngine } from './engine/engine';
import { createStreet } from './world/street';
import { createAudio } from './audio/engine';
import { createMic } from './audio/mic';
import { createHud } from './ui/hud';
import { createScreens } from './ui/screens';
import { getHealth, getSummary, postGuided } from './net/api';
import { FILM } from './ui/film';
import { createPhoneLink } from './net/phoneLink';
import { runWomanWalkHome } from './scenarios/womanWalkHome';
import { runBystanderWalkHome } from './scenarios/bystanderWalkHome';
import { GUIDED, runGuidedWalkHome } from './scenarios/guidedWalkHome';
import type { SceneDeps, SceneResult } from './scenarios/common';
import type { OutcomeKind, Pov, SummaryData } from '../shared/types';
import { createEyeTracker } from './player/eyes';
import { createHandTracker } from './player/hands';
import { createAirPodsLook, detectAirPods } from './player/airpods';
import type { EyeLookSource } from './player/eyes';
import { firstPickTactics } from '../shared/content';

/** The recap screen after the teaching replay, ticking the Ds the player chose first. */
function recapFor(firstChoices: Record<string, string>) {
  const picked = firstPickTactics(GUIDED, firstChoices);
  const { title, stepsTitle, steps, closing } = GUIDED.recap;
  return { title, stepsTitle, steps, closing, fiveDs: GUIDED.recap.fiveDs.map((d) => ({ name: d.name, line: d.line, firstPick: picked.has(d.key) })) };
}

/** Used only if the server cannot produce a debrief (offline, error). No statistics are invented here. */
const FALLBACK_OUTCOME: Record<OutcomeKind, { title: string; body: string }> = {
  he_left: { title: 'He gave up.', body: 'You got home. Your heart is still going.' },
  reached_home_alone: { title: 'You got home.', body: 'He dropped away before you reached your door.' },
  reached_home_followed: { title: 'You got home. He saw which door.', body: 'He was still there when you went in.' },
  took_refuge: { title: 'You waited in the shop.', body: 'You do not know how long he stayed outside.' },
  escalated: { title: 'It became physical.', body: 'The simulation stopped before anything was shown.' },
  intervened_he_left: { title: 'He left.', body: 'Something you did changed what happened to her.' },
  intervened_she_safe: { title: 'She got away from him.', body: 'Something you did gave her a way out.' },
  intervened_escalated: { title: 'He turned on you.', body: 'The simulation stopped before anything was shown.' },
  no_intervention_she_escaped: { title: 'She got away on her own.', body: 'Nobody on the street said anything.' },
  no_intervention_escalated: { title: 'It became physical.', body: 'Nobody on the street said anything.' },
  exited: { title: 'You stopped.', body: 'That is always allowed.' },
};

async function debrief(result: SceneResult, pov: Pov): Promise<SummaryData> {
  if (result.sessionId) {
    try {
      return await getSummary(result.sessionId);
    } catch (err) {
      console.warn('summary unavailable', err);
    }
  }
  return {
    pov,
    outcome: { kind: result.outcome, ...FALLBACK_OUTCOME[result.outcome] },
    durationSec: 0,
    timeline: [],
    insights: [],
    statIds: [],
    modelNotes: [],
  };
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  // Dev shortcuts: ?skip=intro,part1,film,part2 (skipping part1 still plays the film)
  const skip = new Set((params.get('skip') ?? '').split(',').filter(Boolean));
  const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
  const phone = createPhoneLink();
  const hud = createHud(document.querySelector<HTMLElement>('#hud')!, phone);
  const screens = createScreens(document.querySelector<HTMLElement>('#screens')!, { phone });
  hud.setVisible(false);
  screens.loading('Loading…');

  let engine, world, audio, mic;
  try {
    engine = createEngine(canvas);
    world = createStreet(engine);
    audio = createAudio();
    mic = createMic();
  } catch (err) {
    console.error(err);
    screens.error('This simulation needs a desktop browser with WebGL. It could not start on this device.');
    return;
  }

  // The empty street sits behind the opening screens.
  engine.camera.position.set(world.points.subwayExit.x, 1.62, world.points.subwayExit.z + 1);
  engine.camera.lookAt(world.points.subwayExit.x - 0.6, 1.5, world.points.subwayExit.z - 30);
  const idle = engine.onUpdate((dt, t) => world.update(dt, t));
  engine.start();

  // Webcam head look (G, Shift+G recalibrates) and hand gestures (H) share one camera.
  // ?eyes=1 / ?hands=1 start them after the intro; ?eyegain=1.4 makes head look more sensitive, ?eyegainy=1.5 only up/down.
  const eyes = createEyeTracker({
    sensitivity: params.has('eyegain') ? Number(params.get('eyegain')) : 1,
    verticalSensitivity: params.has('eyegainy') ? Number(params.get('eyegainy')) : undefined,
  });
  const hands = createHandTracker();
  // AirPods head tracking (via the macOS helper, `npm run airpods`) takes over head look when available.
  const airpods = createAirPodsLook({ flipX: params.get('airpodsx') === '-1', flipY: params.get('airpodsy') === '-1' });
  const headLook: EyeLookSource = { read: () => airpods.read() ?? eyes.read() };
  const lookForAirPods = () => void detectAirPods().then((found) => (found || params.get('airpods') === '1') && airpods.start());
  lookForAirPods();
  // "Straight ahead" for the AirPods is wherever the head is at the next reading. Taken at page load it can be
  // far off (looking down at the keyboard on the intro) and pins the view to an edge, so take it again as each
  // scene starts, while the title card is up and the player is facing the screen.
  const recentreAirPods = () => airpods.recalibrate();
  // Device names only show once microphone permission is granted, and AirPods can connect mid-session: look again then.
  navigator.mediaDevices?.addEventListener?.('devicechange', lookForAirPods);
  window.addEventListener('keydown', (e) => {
    if ((e.code !== 'KeyG' && e.code !== 'KeyH') || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = document.activeElement;
    if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (e.code === 'KeyH') hands.toggle();
    else if (e.shiftKey) {
      eyes.recalibrate();
      airpods.recalibrate();
    }
    else eyes.toggle();
  });

  const health = await getHealth();
  const seed = params.has('seed') ? Number(params.get('seed')) : undefined;
  const deps: SceneDeps = {
    engine,
    world,
    audio,
    mic,
    hud,
    voice: health.voice,
    requireLock: params.get('nolock') !== '1',
    seed,
    // ?run=golden: the scripted reference playthrough (docs/golden-run.md).
    run: params.get('run') === 'golden' ? 'golden' : undefined,
    eyes: headLook,
    hands,
    phone,
    demo: params.get('demo') === '1',
  };
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__oit = deps;

  screens.loading(null);
  // Keyboard or body, asked once (?mode=immersive when the intro is skipped).
  if (!skip.has('intro')) {
    deps.mode = await screens.intro({ voiceAvailable: health.voice, requestMic: () => mic.init().finally(lookForAirPods) });
  } else {
    void mic.init().finally(lookForAirPods);
    deps.mode = params.get('mode') === 'immersive' ? 'immersive' : 'analog';
  }
  if (params.get('eyes') === '1' || deps.mode === 'immersive') void eyes.enable();
  if (params.get('hands') === '1' || deps.mode === 'immersive') void hands.enable();
  await audio.resume();
  await audio.load((f) => screens.loading('Preparing the street…', f));
  screens.loading(null);
  idle(); // the scenes drive world.update from here on

  run: for (;;) {
    let exited = false;
    /** The Part 2 run the guided replay's choices are logged against (the last one, after any "Walk it again"). */
    let part2: SceneResult | null = null;
    /** Part 1's debrief, fetched while the film plays and offered from the Part 2 brief ("See full details"). */
    let part1Details: Promise<SummaryData> | null = null;
    /** Part 1's session, for the coach (Part 3). */
    let part1Session: string | null = null;

    if (!skip.has('part1')) {
      await screens.briefing('woman');
      await audio.resume();
      world.setDoorOpen('home', false);
      recentreAirPods();
      const result = await runWomanWalkHome(deps);
      hud.setVisible(false);
      if (result.outcome === 'exited') exited = true;
      else {
        part1Details = debrief(result, 'woman'); // never rejects: falls back to a local outcome
        part1Session = result.sessionId || null;
      }
    }

    // The film replaces Part 1's debrief in the main flow (?skip=film leaves it out).
    if (!exited && !skip.has('film')) {
      audio.stopAmbience(0.6);
      await screens.film({ src: FILM.src, track: FILM.track });
    }

    if (!exited && !skip.has('part2')) {
      let offerDetails = part1Details !== null;
      for (;;) {
        const choice = await screens.briefing('bystander', { details: offerDetails });
        if (choice === 'details' && part1Details) {
          screens.loading('…');
          const summary = await part1Details;
          screens.loading(null);
          // "Walk it again" from the old debrief replays Part 1 (and its film); "Continue" returns to this brief.
          if ((await screens.summary(summary)) === 'retry') continue run;
          continue;
        }
        offerDetails = false;
        await audio.resume();
        world.setDoorOpen('home', false);
        recentreAirPods();
        const result = await runBystanderWalkHome(deps);
        hud.setVisible(false);
        part2 = result;
        if (result.outcome === 'exited') {
          exited = true;
          break;
        }
        screens.loading('…');
        const summary = await debrief(result, 'bystander');
        screens.loading(null);
        if ((await screens.summary(summary)) === 'continue') break;
      }
    }

    // The recap of the 5 Ds after Part 2 (its tips replace the separate teaching replay).
    // ?replay=1 still plays the replay (Part 2 again, frozen at five moments) first, and ticks the Ds picked there.
    if (!exited && part2) {
      let picks: Record<string, string> = {};
      if (params.get('replay') === '1') {
        await audio.resume();
        world.setDoorOpen('home', false);
        recentreAirPods();
        const guided = await runGuidedWalkHome(deps);
        hud.setVisible(false);
        exited = guided.exited;
        picks = guided.firstChoices;
      }
      if (part2.sessionId && Object.keys(picks).length) void postGuided(part2.sessionId, picks, part2.outcome);
      // Part 3, the debrief coach (worker/coach/), is offered on the recap when the server has a model key
      // and Part 2 was recorded. It is optional: "Finish" goes on exactly as before. ?coach=0 hides it.
      const offerCoach = Boolean(health.coach) && Boolean(part2.sessionId) && params.get('coach') !== '0';
      while (!exited && (await screens.recap({ ...recapFor(picks), coach: offerCoach })) === 'coach') {
        await screens.coach({ bystander: part2.sessionId, woman: part1Session ?? undefined });
      }
    }

    audio.stopAmbience(1);
    await hud.fade(true, 0);
    await screens.closing();
    skip.clear();
  }
}

void main();
