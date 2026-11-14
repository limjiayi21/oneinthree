import { createEngine } from './engine/engine';
import { createStreet } from './world/street';
import { createAudio } from './audio/engine';
import { createMic } from './audio/mic';
import { createHud } from './ui/hud';
import { createScreens } from './ui/screens';
import { getHealth, getSummary } from './net/api';
import { runWomanWalkHome } from './scenarios/womanWalkHome';
import { runBystanderWalkHome } from './scenarios/bystanderWalkHome';
import type { SceneDeps, SceneResult } from './scenarios/common';
import type { OutcomeKind, Pov, SummaryData } from '../shared/types';
import { resolveSeed } from '../shared/demo';

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
  // Dev shortcuts: ?skip=intro,part1
  const skip = new Set((params.get('skip') ?? '').split(',').filter(Boolean));
  const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
  const hud = createHud(document.querySelector<HTMLElement>('#hud')!);
  const screens = createScreens(document.querySelector<HTMLElement>('#screens')!);
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

  const health = await getHealth();
  const seed = resolveSeed({ seed: params.get('seed'), demo: params.get('demo') });
  const deps: SceneDeps = {
    engine,
    world,
    audio,
    mic,
    hud,
    voice: health.voice,
    agent: Boolean(health.agent),
    requireLock: params.get('nolock') !== '1',
    seed,
  };
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__oit = deps;

  screens.loading(null);
  if (!skip.has('intro')) {
    await screens.intro({ voiceAvailable: health.voice, requestMic: () => mic.init() });
  } else {
    void mic.init();
  }
  await audio.resume();
  await audio.load((f) => screens.loading('Preparing the street…', f));
  screens.loading(null);
  idle(); // the scenes drive world.update from here on

  for (;;) {
    let exited = false;

    if (!skip.has('part1')) {
      for (;;) {
        await screens.briefing('woman');
        await audio.resume();
        world.setDoorOpen('home', false);
        const result = await runWomanWalkHome(deps);
        hud.setVisible(false);
        if (result.outcome === 'exited') {
          exited = true;
          break;
        }
        screens.loading('…');
        const summary = await debrief(result, 'woman');
        screens.loading(null);
        if ((await screens.summary(summary)) === 'continue') break;
      }
    }

    if (!exited) {
      for (;;) {
        await screens.briefing('bystander');
        await audio.resume();
        world.setDoorOpen('home', false);
        const result = await runBystanderWalkHome(deps);
        hud.setVisible(false);
        if (result.outcome === 'exited') break;
        screens.loading('…');
        const summary = await debrief(result, 'bystander');
        screens.loading(null);
        if ((await screens.summary(summary)) === 'continue') break;
      }
    }

    audio.stopAmbience(1);
    await hud.fade(true, 0);
    await screens.closing();
    skip.clear();
  }
}

void main();
