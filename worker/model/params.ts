/**
 * The single parameter table behind the decision model.
 *
 * Every number that shapes what the man does lives here and carries
 * { value, basis, rationale, sourceIds }. Parameters whose key exists in
 * content/evidence.json (modelCalibration.parameters) are read from that file
 * at load time, key for key, so the research stays the source of truth. The
 * rest (keys starting "model.") are this model's own knobs: nobody has measured
 * them, so they are labelled 'assumption' and say so.
 *
 * Nothing here is a statistic shown to the trainee; those are referenced by
 * statId from evidence.json in the summary.
 */
import evidenceJson from '../../content/evidence.json';
import type { CalibrationParameter, Evidence } from '../../shared/evidence';

export type Basis = 'data' | 'inferred' | 'assumption';

export interface Param {
  key: string;
  value: number;
  range?: [number, number];
  basis: Basis;
  rationale: string;
  sourceIds: string[];
  /** 'evidence' = read from evidence.json under the same key; 'model' = this model's own knob. */
  origin: 'evidence' | 'model';
}

interface Def {
  key: string;
  /** Fallback value (used as-is for model.* keys; used only if evidence.json lacks the key otherwise). */
  value: number;
  range?: [number, number];
  rationale: string;
  sourceIds?: string[];
  /** Read value, range, basis, rationale and sources from evidence.json under this exact key. */
  evidence?: true;
}

const E = (key: string, value: number, range: [number, number]): Def => ({
  key,
  value,
  range,
  evidence: true,
  rationale: 'Conservative placeholder used only when content/evidence.json has no entry under this key.',
});

const M = (key: string, value: number, rationale: string, sourceIds: string[] = [], range?: [number, number]): Def => ({
  key,
  value,
  range,
  rationale,
  sourceIds,
});

const NO_RATE = 'No study measures how a street harasser reacts to a specific response, so this is a placeholder.';

const DEFS: Def[] = [
  /* ------------------------------------------------------------------ evidence.json keys (woman POV) */
  E('man.disposition.wants_friendly_response', 0.85, [0.73, 0.85]),
  E('man.disposition.hostile_from_start', 0.08, [0.05, 0.12]),
  E('man.disposition.persistent_entitled', 0.25, [0.15, 0.35]),
  E('base.physical_escalation_per_run', 0.03, [0, 0.05]),
  E('base.incident_involves_following', 0.18, [0.14, 0.2]),
  E('base.incident_involves_path_interference', 0.43, [0.4, 0.45]),
  E('base.encounter_stays_verbal_only', 0.7, [0.55, 0.85]),
  E('response.ignore.p_back_off', 0.5, [0.35, 0.65]),
  E('response.ignore.p_persist_or_follow', 0.35, [0.2, 0.5]),
  E('response.ignore.p_verbal_hostility', 0.15, [0.05, 0.3]),
  E('response.polite_deflection.p_persist', 0.5, [0.35, 0.65]),
  E('response.polite_deflection.p_verbal_hostility', 0.1, [0.05, 0.25]),
  E('response.firm_boundary.p_back_off', 0.45, [0.3, 0.6]),
  E('response.firm_boundary.p_verbal_hostility', 0.3, [0.15, 0.4]),
  E('response.hostile_insult.p_verbal_hostility', 0.5, [0.35, 0.65]),
  E('response.hostile_insult.p_intimidation', 0.15, [0.05, 0.25]),
  E('response.lie_or_excuse.p_persist', 0.45, [0.3, 0.6]),
  E('response.lie_or_excuse.p_verbal_hostility', 0.1, [0.05, 0.2]),
  E('response.threat_police_or_attention.p_back_off', 0.55, [0.4, 0.7]),
  E('response.threat_police_or_attention.p_verbal_hostility', 0.2, [0.1, 0.35]),
  E('response.seek_refuge.p_back_off', 0.75, [0.6, 0.9]),
  E('response.engage_friendly.p_persist', 0.8, [0.65, 0.9]),

  /* ------------------------------------------------------------------ evidence.json keys (bystander POV) */
  E('bystander.any_action.p_harassment_stops', 0.65, [0.5, 0.8]),
  E('bystander.distract.p_harassment_stops', 0.65, [0.5, 0.8]),
  E('bystander.distract.p_hostility_toward_bystander', 0.05, [0, 0.1]),
  E('bystander.direct.p_harassment_stops', 0.65, [0.5, 0.8]),
  E('bystander.direct.p_hostility_toward_bystander', 0.25, [0.1, 0.4]),
  E('bystander.delegate.p_harassment_stops', 0.55, [0.4, 0.7]),
  E('bystander.document.p_harassment_stops', 0.15, [0.05, 0.3]),
  E('bystander.delay.target_distress_reduction', 0.3, [0.15, 0.45]),
  E('bystander.nothing.target_distress_increase', 0.25, [0.1, 0.4]),

  /* ------------------------------------------------------------------ rows the research leaves open
   * The research gives two or three of the four reaction shares for most responses. The remaining
   * shares are filled in here so each row is complete; rows are re-normalised when used. */
  M('model.response.ignore.p_intimidation', 0.02, `${NO_RATE} Kept very small: quiet menace after silence appears in accounts but is not the usual pattern.`, ['ssh_2014']),
  M('model.response.polite_deflection.p_back_off', 0.38, `${NO_RATE} The remainder of the row once the researched persistence and hostility shares are taken out.`, ['ssh_assertive']),
  M('model.response.polite_deflection.p_intimidation', 0.02, `${NO_RATE} Kept very small.`),
  M('model.response.firm_boundary.p_persist', 0.23, `${NO_RATE} The remainder of the row once the researched back-off and hostility shares are taken out.`, ['fleetwood_2019']),
  M('model.response.firm_boundary.p_intimidation', 0.02, `${NO_RATE} Kept very small.`),
  M('model.response.hostile_insult.p_back_off', 0.2, `${NO_RATE} Part of the remainder of the row: narrative research describes men walking off or going quiet even after being shouted at.`, ['fleetwood_2019']),
  M('model.response.hostile_insult.p_persist', 0.15, `${NO_RATE} Part of the remainder of the row.`),
  M('model.response.lie_or_excuse.p_back_off', 0.43, `${NO_RATE} The remainder of the row once the researched persistence and hostility shares are taken out.`, ['stratmoen_2020']),
  M('model.response.lie_or_excuse.p_intimidation', 0.02, `${NO_RATE} Kept very small.`),
  M('model.response.threat_police_or_attention.p_persist', 0.22, `${NO_RATE} The remainder of the row once the researched back-off and hostility shares are taken out.`),
  M('model.response.threat_police_or_attention.p_intimidation', 0.03, `${NO_RATE} Kept very small: a public threat is a status challenge, so slightly above the other calm responses.`, ['stratmoen_2018_pt']),
  M('model.response.seek_refuge.p_persist', 0.15, `${NO_RATE} Part of the remainder of the row; accounts include men who wait outside.`, ['ssh_2014']),
  M('model.response.seek_refuge.p_verbal_hostility', 0.08, `${NO_RATE} Part of the remainder of the row.`),
  M('model.response.seek_refuge.p_intimidation', 0.02, `${NO_RATE} Kept very small.`),
  M('model.response.engage_friendly.p_back_off', 0.14, `${NO_RATE} Part of the remainder of the row: a friendly answer rarely ends the contact.`, ['psypost_walton_2021']),
  M('model.response.engage_friendly.p_verbal_hostility', 0.05, `${NO_RATE} Kept small: he is getting the reaction he hoped for.`, ['psypost_walton_2021']),
  M('model.response.engage_friendly.p_intimidation', 0.01, `${NO_RATE} Kept very small.`),
  M('model.response.plead.p_back_off', 0.4, `${NO_RATE} The research has no entry for pleading; treated like a soft refusal.`),
  M('model.response.plead.p_persist', 0.45, `${NO_RATE} The research has no entry for pleading; treated like a soft refusal.`),
  M('model.response.plead.p_verbal_hostility', 0.1, `${NO_RATE} The research has no entry for pleading; treated like a soft refusal.`),
  M('model.response.plead.p_intimidation', 0.05, `${NO_RATE} Slightly above other soft responses because a minority of men who do this say they want her to feel intimidated.`, ['psypost_walton_2021']),
  M('model.response.unclear.p_back_off', 0.42, `${NO_RATE} Used when her words could not be read; sits between silence and a polite refusal.`),
  M('model.response.unclear.p_persist', 0.45, `${NO_RATE} Used when her words could not be read; sits between silence and a polite refusal.`),
  M('model.response.unclear.p_verbal_hostility', 0.11, `${NO_RATE} Used when her words could not be read; sits between silence and a polite refusal.`),
  M('model.response.unclear.p_intimidation', 0.02, `${NO_RATE} Kept very small.`),

  /* ------------------------------------------------------------------ disposition (drawn once per session) */
  M('model.disposition.mild.back_off', 1.5, 'Odds multiplier. A man who mainly hopes for a friendly reaction is assumed to give up sooner than average. Magnitude is a guess; chosen so the mix of dispositions reproduces the researched reaction shares.', ['psypost_walton_2021']),
  M('model.disposition.mild.persist', 0.75, 'Odds multiplier for the mild disposition. Magnitude is a guess.'),
  M('model.disposition.mild.hostile', 0.55, 'Odds multiplier for the mild disposition. Magnitude is a guess.'),
  M('model.disposition.mild.intimidate', 0.4, 'Odds multiplier for the mild disposition. Magnitude is a guess.'),
  M('model.disposition.persistent.back_off', 0.45, 'Odds multiplier. A man who feels entitled to her attention is assumed to give up far less readily. Magnitude is a guess.', ['walton_pedersen_2021', 'pew_2020']),
  M('model.disposition.persistent.persist', 1.6, 'Odds multiplier for the persistent disposition. Magnitude is a guess.', ['walton_pedersen_2021', 'pew_2020']),
  M('model.disposition.persistent.hostile', 1.0, 'Odds multiplier for the persistent disposition: no more or less hostile than average. A guess.'),
  M('model.disposition.persistent.intimidate', 1.0, 'Odds multiplier for the persistent disposition. A guess.'),
  M('model.disposition.volatile.back_off', 0.45, 'Odds multiplier. A man who set out to unsettle her is assumed not to walk away easily. Magnitude is a guess.', ['psypost_walton_2021', 'pbs_2014']),
  M('model.disposition.volatile.persist', 0.8, 'Odds multiplier for the volatile disposition. A guess.'),
  M('model.disposition.volatile.hostile', 2.2, 'Odds multiplier. Lab work finds aggression after refusal concentrated in men with hostile views of the woman; the size of the effect on a street is unknown.', ['woerner_2018']),
  M('model.disposition.volatile.intimidate', 2.5, 'Odds multiplier for the volatile disposition. Magnitude is a guess.', ['woerner_2018']),

  /* ------------------------------------------------------------------ the demo persona */
  M('model.scenario.pushiness_first_response', 0.45, "Odds multiplier on giving up after her very first response. Not evidence: the founders' brief for this demo is a pushy man, so he usually tries at least once more. This is the knob an intensity setting would turn."),
  M('model.scenario.pushiness_second_response', 0.75, "Odds multiplier on giving up after her second response. Not evidence: part of the demo persona (see model.scenario.pushiness_first_response)."),

  /* ------------------------------------------------------------------ what builds up over the encounter */
  M('model.dynamics.frustration_gain', 1.2, 'How strongly accumulated rejection raises the odds of hostility and intimidation. Direction from experiments in which rejected men became more hostile, with anger as the mechanism; magnitude is a guess.', ['andrighetto_2019', 'woerner_2018', 'blake_2018']),
  M('model.dynamics.frustration.ignore', 0.08, 'Frustration added when she ignores him. Accounts describe anger at being ignored but give no rates; kept small.', ['ssh_2014']),
  M('model.dynamics.frustration.polite_deflect', 0.06, 'Frustration added by a polite refusal. A guess; kept small.'),
  M('model.dynamics.frustration.firm_boundary', 0.15, 'Frustration added by a clear refusal. Direction from rejection experiments; magnitude is a guess.', ['woerner_2018', 'andrighetto_2019']),
  M('model.dynamics.frustration.hostile', 0.3, 'Frustration added when she insults him. Kept the largest: guidance names swearing or losing your temper as the reaction most likely to be met with anger, and honour-belief research links perceived insult to aggression.', ['ssh_assertive', 'stratmoen_2018_pt']),
  M('model.dynamics.frustration.excuse', 0.05, 'Frustration added by an excuse. A guess; kept small because excuses are used to soften a refusal.', ['stratmoen_2020']),
  M('model.dynamics.frustration.threaten_attention', 0.16, 'Frustration added when she threatens police or attention: a public status challenge. Magnitude is a guess.', ['stratmoen_2018_pt']),
  M('model.dynamics.frustration.seek_help', 0.08, 'Frustration added when she turns to other people. A guess.'),
  M('model.dynamics.frustration.engage', -0.1, 'A friendly answer lowers his frustration: it is the reaction most of these men say they want.', ['psypost_walton_2021']),
  M('model.dynamics.frustration.plead', 0.0, 'Pleading neither adds to nor reduces his frustration. A guess.'),
  M('model.dynamics.frustration.unclear', 0.04, 'Frustration added when her words could not be read. A guess.'),
  M('model.dynamics.fatigue_gain', 3.0, 'How much more likely he is to give up as the encounter drags on (odds multiplier reached at model.session.soft_seconds, growing with the square of time). A design choice that bounds the session, not a finding.'),
  M('model.session.soft_seconds', 150, 'Length of encounter, in seconds, at which fatigue reaches full strength. A design choice.'),
  M('model.session.max_seconds', 215, 'Hard bound: after this many seconds of encounter he gives up whatever else is happening. A design choice so a session always ends.'),
  M('model.dynamics.hostile_inertia_back_off', 1.5, 'Once he has turned hostile he is more likely to leave with a parting insult than to start over. Reports describe harassers making a quick exit; the multiplier is a guess.', ['hutson_krueger_2018']),
  M('model.dynamics.hostile_inertia_persist', 0.45, 'Once he has turned hostile he rarely goes back to charm. A guess.'),
  M('model.dynamics.hostile_inertia_hostile', 1.2, 'Once hostile, staying hostile is a little more likely. A guess.'),
  M('model.dynamics.early_intimidation', 0.6, 'Odds multiplier on quiet menace in the first two exchanges: he starts out believing he is being charming. A guess.', ['psypost_walton_2021']),
  M('model.dynamics.reengage_after_insult', 0.2, 'Chance that he turns back if she insults him while he is already walking away. A guess; direction from guidance that insults are the likeliest trigger for anger.', ['ssh_assertive']),
  M('model.dynamics.distance_back_off', 1.2, 'Odds multiplier on giving up once she has put the street between them: pursuing now takes visible effort. A guess; harassers are described as relying on going unnoticed.', ['pbs_2014', 'wesselmann_kelly_2010']),

  /* ------------------------------------------------------------------ how persistence looks */
  M('model.persist.share_block', 0.14, 'Share of "keeps going" turns in which he steps into her path. Bounded above by the researched share of incidents with path interference minus following; set lower because those archives over-represent severe incidents.', ['hutson_krueger_2018']),
  M('model.persist.share_guilt', 0.22, 'Share of "keeps going" turns in which he turns it back on her ("I\'m just being nice"). Guilt-tripping is named in practitioner guidance; the share is a guess.', ['ssh_assertive']),
  M('model.persist.moving_follow_boost', 2.0, 'He trails her more often when she walks off, hurries or crosses: staying in contact requires it. A guess.', ['ssh_2014']),
  M('model.persist.refusal_guilt_boost', 1.6, 'Guilt-tripping is more likely straight after a polite or firm refusal. A guess.', ['ssh_assertive']),
  M('model.persist.engage_talk_boost', 2.0, 'After a friendly answer he mostly keeps talking rather than following or blocking. A guess.', ['psypost_walton_2021', 'ssh_2014']),
  M('model.persist.evade_block_boost', 1.3, 'Stepping into her path is a little more likely when she is trying to get away. A guess.', ['hutson_krueger_2018']),
  M('model.persist.block_max', 2, 'He blocks her path at most this many times in one encounter. A design bound.'),
  M('model.persist.follow_silent', 0.3, 'Chance that he says nothing on a turn where he is only trailing her. A guess.'),

  /* ------------------------------------------------------------------ physical escalation (rare) */
  M('model.escalation.min_turn', 4, "Earliest decision (his opening call-out is 1) at which he can become physical. A design rule: never in the first exchanges."),
  M('model.escalation.hazard', 0.034, 'Chance per eligible turn (he is already hostile or menacing, close to her, past the minimum turn) that he becomes physical. Tuned by simulation so the per-session rate stays inside the range of base.physical_escalation_per_run; no per-encounter denominator exists.', ['bastomski_2011', 'cornell_nyc_2012']),
  M('model.escalation.insult_gain', 0.15, 'Each time she has insulted him raises that chance by this fraction. Only the direction is supported (guidance and honour-belief research); the size is a guess.', ['ssh_assertive', 'stratmoen_2018_pt']),
  M('model.escalation.intimidate_factor', 1.3, 'Multiplier when he is already in close, quiet menace rather than shouting. A guess.'),
  M('model.escalation.volatile_factor', 2.0, 'Multiplier for the volatile disposition. Lab work points to a hostile minority; the size is a guess.', ['woerner_2018']),
  M('model.escalation.mild_factor', 0.35, 'Multiplier for the mild disposition. A guess.'),
  M('model.dynamics.far_factor', 0.2, 'Odds multiplier on close-range moves (quiet menace, becoming physical) when she is more than a few metres away or across the street. A guess that follows from the geometry.'),
  M('model.escalation.cap', 0.12, 'Upper limit on the per-turn chance of physical escalation whatever has happened. A design bound that keeps it rare.'),

  /* ------------------------------------------------------------------ blending in Clef's reading of her words */
  M('model.blend.clef_weight', 0.35, "Exponent on Clef's distribution over his next move when it is multiplied into the evidence-based prior. Modest by design: her exact words matter, but less than his disposition."),
  M('model.blend.likelihood_floor', 0.05, "Smallest probability Clef's reading is allowed to assign to any move, so it can never rule one out. A design bound."),
  M('model.blend.default_band', 0.4, "How far (as a fraction) the blend may move a reaction share that has no researched range. Shares with a researched range may only move within that range."),

  /* ------------------------------------------------------------------ bystander POV: this model's own knobs */
  M('model.bystander.aggressive.p_harassment_stops', 0.45, 'Chance the harassment stops when the bystander threatens or insults him. No outcome data by tactic; set below a calm Direct because guidance says to keep it short and not argue.', ['rtb_5ds']),
  M('model.bystander.aggressive.p_hostility_toward_bystander', 0.45, 'Chance he turns on a bystander who threatens or insults him. No rates exist; set clearly above the researched value for a calm Direct, on the guidance that Direct can redirect abuse to the bystander.', ['rtb_5ds', 'wins_bronx_2022']),
  M('model.bystander.delegate.p_hostility_toward_bystander', 0.05, 'Chance he turns on the bystander after someone with standing in the space steps in. No data; set at the level of Distract because Delegate is also indirect.', ['rtb_5ds']),
  M('model.bystander.document.p_hostility_toward_bystander', 0.2, 'Chance he turns on a bystander he notices filming him. No data; a guess between Distract and Direct.', ['rtb_5ds']),
  M('model.bystander.document.p_notice_near', 0.6, 'Chance he notices a phone pointed at him from within a few metres. A guess.'),
  M('model.bystander.document.p_notice_mid', 0.25, 'Chance he notices a phone pointed at him from across the sidewalk. A guess.'),
  M('model.bystander.document.p_notice_far', 0.05, 'Chance he notices a phone pointed at him from far away. A guess.'),
  M('model.bystander.physical.p_hostility_toward_bystander', 0.15, 'Chance he turns on a bystander who silently steps between them. No data; a guess between Distract and Direct.', ['rtb_5ds']),
  M('model.bystander.interruption.p_harassment_stops', 0.3, 'Chance the harassment stops when a bystander close by says something that could not be read as any tactic. A guess: any interruption breaks his momentum a little.', ['rtb_5ds']),
  M('model.bystander.repeat_boost', 1.2, 'Odds multiplier on the harassment stopping at a second or later intervention. A guess: he now knows he is being watched.', ['pbs_2014']),
  M('model.bystander.turned.p_back_off', 0.6, 'Once he has turned on the bystander, chance per exchange that he blusters and leaves. A guess.'),
  M('model.bystander.turned.p_escalates', 0.03, 'Once he has turned on the bystander, chance per later exchange that he becomes physical if the bystander stays calm. Set at the level of base.physical_escalation_per_run; real cases of injured bystanders exist but no rates.', ['wins_bronx_2022']),
  M('model.bystander.turned.p_escalates_if_provoked', 0.1, 'The same chance when the bystander keeps threatening or insulting him. Only the direction is supported; the size is a guess.', ['rtb_5ds', 'wins_bronx_2022']),
  M('model.bystander.clerk_second_warning.p_harassment_stops', 0.85, "Chance he leaves once the shopkeeper says he is calling the police. A guess; harassers are described as relying on going unnoticed.", ['pbs_2014', 'wesselmann_kelly_2010']),
  M('model.bystander.she_slips_away', 0.5, 'Chance she uses the moment he turns on the bystander to get away at once. A guess.'),
];

export type Params = Map<string, Param>;

function isRange(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** Build the table from an Evidence object (tests pass their own; the Worker uses content/evidence.json). */
export function buildParams(evidence: Pick<Evidence, 'sources' | 'modelCalibration'>): Params {
  const known = new Set(Object.keys(evidence.sources ?? {}));
  const cal = new Map<string, CalibrationParameter>();
  for (const p of evidence.modelCalibration?.parameters ?? []) {
    if (p && typeof p.key === 'string') cal.set(p.key, p);
  }
  const out: Params = new Map();
  for (const d of DEFS) {
    const fromFile = d.evidence ? cal.get(d.key) : undefined;
    if (fromFile && typeof fromFile.value === 'number' && Number.isFinite(fromFile.value)) {
      const basis: Basis = fromFile.basis === 'data' || fromFile.basis === 'inferred' ? fromFile.basis : 'assumption';
      out.set(d.key, {
        key: d.key,
        value: fromFile.value,
        range: isRange(fromFile.range) ? fromFile.range : d.range,
        basis,
        rationale: String(fromFile.rationale ?? ''),
        sourceIds: (fromFile.sourceIds ?? []).filter((s) => known.has(s)),
        origin: 'evidence',
      });
    } else {
      out.set(d.key, {
        key: d.key,
        value: d.value,
        range: d.range,
        basis: 'assumption',
        rationale: d.rationale,
        // Only cite sources that actually exist in evidence.json.
        sourceIds: (d.sourceIds ?? []).filter((s) => known.has(s)),
        origin: 'model',
      });
    }
  }
  return out;
}

export const EVIDENCE = evidenceJson as unknown as Evidence;
export const PARAMS: Params = buildParams(EVIDENCE);

export function param(params: Params, key: string): Param {
  const p = params.get(key);
  if (!p) throw new Error(`Unknown model parameter: ${key}`);
  return p;
}

export const val = (params: Params, key: string): number => param(params, key).value;

/** Weakest basis among several parameters: an output is only as solid as its weakest input. */
export function weakestBasis(list: Param[]): Basis {
  if (list.some((p) => p.basis === 'assumption')) return 'assumption';
  if (list.some((p) => p.basis === 'inferred')) return 'inferred';
  return list.length ? 'data' : 'assumption';
}

export function paramKeys(): string[] {
  return DEFS.map((d) => d.key);
}

/** Keys this model expects to find in evidence.json. */
export function evidenceKeys(): string[] {
  return DEFS.filter((d) => d.evidence).map((d) => d.key);
}
