/**
 * Access to content/evidence.json for the screens. Every statistic, case,
 * definition and phone number the interface shows is read from that file at
 * runtime; nothing factual is written into the UI code.
 *
 * The file is authored by hand / by a research pass, so it is normalised
 * defensively here: missing sections become empty, malformed entries are
 * dropped, and only http(s) links are ever turned into anchors.
 */

import evidenceJson from '../../content/evidence.json';
import type {
  BehaviourFinding,
  CalibrationParameter,
  CaseStudy,
  Evidence,
  EvidenceSource,
  EvidenceStat,
  FiveD,
  SupportResource,
} from '../../shared/evidence';

type Dict = Record<string, unknown>;

const isObj = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const list = (v: unknown): Dict[] => (Array.isArray(v) ? v.filter(isObj) : []);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);

export const EMPTY_EVIDENCE: Evidence = {
  sources: {},
  stats: [],
  caseStudies: [],
  harasserBehaviour: [],
  bystander: { fiveDs: [], findings: [] },
  modelCalibration: { notes: '', parameters: [] },
  resources: [],
};

/** Coerce anything JSON-shaped into a safe Evidence object. */
export function normaliseEvidence(raw: unknown): Evidence {
  if (!isObj(raw)) return EMPTY_EVIDENCE;

  const sources: Record<string, EvidenceSource> = {};
  if (isObj(raw.sources)) {
    for (const [key, value] of Object.entries(raw.sources)) {
      if (!isObj(value)) continue;
      const id = str(value.id) || key;
      const publisher = str(value.publisher);
      const title = str(value.title);
      if (!publisher && !title) continue;
      sources[key] = { id, title, publisher, year: num(value.year), url: str(value.url), accessed: str(value.accessed) };
    }
  }

  const stats = list(raw.stats)
    .filter((s) => str(s.id) && str(s.headline))
    .map((s) => ({ ...s, id: str(s.id), headline: str(s.headline), text: str(s.text), detail: str(s.detail) || undefined, sourceId: str(s.sourceId) }) as EvidenceStat);

  const caseStudies = list(raw.caseStudies)
    .filter((c) => str(c.id) && str(c.name) && str(c.summary))
    .map((c) => ({ ...c, id: str(c.id), name: str(c.name), location: str(c.location), year: num(c.year), summary: str(c.summary), sourceIds: strList(c.sourceIds) }) as CaseStudy);

  const harasserBehaviour = list(raw.harasserBehaviour)
    .filter((f) => str(f.finding))
    .map((f) => ({ ...f, id: str(f.id), finding: str(f.finding), sourceId: str(f.sourceId) }) as BehaviourFinding);

  const bystanderRaw = isObj(raw.bystander) ? raw.bystander : {};
  const fiveDs = list(bystanderRaw.fiveDs)
    .filter((d) => str(d.key))
    .map((d) => ({ key: str(d.key), name: str(d.name), description: str(d.description), example: str(d.example) }) as FiveD);
  const findings = list(bystanderRaw.findings)
    .filter((f) => str(f.finding))
    .map((f) => ({ id: str(f.id), finding: str(f.finding), sourceId: str(f.sourceId) }));

  const calRaw = isObj(raw.modelCalibration) ? raw.modelCalibration : {};
  const parameters = list(calRaw.parameters)
    .filter((p) => str(p.key))
    .map((p) => ({ ...p, key: str(p.key), value: num(p.value), rationale: str(p.rationale), sourceIds: strList(p.sourceIds) }) as CalibrationParameter);

  const resources = list(raw.resources)
    .filter((r) => str(r.name))
    .map((r) => ({ ...r, name: str(r.name), description: str(r.description), url: str(r.url), phone: str(r.phone) || undefined }) as SupportResource);

  return {
    sources,
    stats,
    caseStudies,
    harasserBehaviour,
    bystander: { fiveDs, findings },
    modelCalibration: { notes: str(calRaw.notes), parameters },
    resources,
  };
}

/** The evidence shipped with the build. */
export const bundledEvidence: Evidence = normaliseEvidence(evidenceJson as unknown);

/** Only http(s) URLs are ever linked. */
export function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function hostOf(url: string | undefined): string {
  const safe = safeUrl(url);
  if (!safe) return '';
  try {
    return new URL(safe).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function resolveSources(evidence: Evidence, ids: readonly (string | undefined)[] | undefined): EvidenceSource[] {
  const out: EvidenceSource[] = [];
  const seen = new Set<string>();
  for (const id of ids ?? []) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const source = evidence.sources[id] ?? Object.values(evidence.sources).find((s) => s.id === id);
    if (source) out.push(source);
  }
  return out;
}

export function resolveStats(evidence: Evidence, ids: readonly string[] | undefined): EvidenceStat[] {
  const out: EvidenceStat[] = [];
  const seen = new Set<string>();
  for (const id of ids ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const stat = evidence.stats.find((s) => s.id === id);
    if (stat) out.push(stat);
  }
  return out;
}

/**
 * The statistic the product is named after: the global prevalence figure.
 * Prefers an entry whose headline reads "1 in 3"; falls back to any global
 * prevalence entry; undefined when the evidence has none (the title screen
 * then simply omits it).
 */
export function headlineStat(evidence: Evidence): EvidenceStat | undefined {
  const global = evidence.stats.filter((s) => s.region === 'global' && s.topic === 'prevalence');
  return global.find((s) => /\b(1|one)\s+in\s+(3|three)\b/i.test(s.headline)) ?? global[0];
}
