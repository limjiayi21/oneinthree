/** Shape of content/evidence.json: every figure in the product traces back to a source here. */

export interface EvidenceSource {
  id: string;
  title: string;
  publisher: string;
  year: number;
  url: string;
  accessed: string;
}

export interface EvidenceStat {
  id: string;
  /** The big number, e.g. "65%" or "1 in 3". */
  headline: string;
  /** Continues the sentence after the headline. */
  text: string;
  detail?: string;
  sourceId: string;
  region: 'global' | 'us' | 'nyc' | 'uk' | 'international';
  topic:
    | 'prevalence'
    | 'following'
    | 'touching'
    | 'fear'
    | 'behaviour_change'
    | 'reporting'
    | 'bystander'
    | 'response'
    | 'escalation'
    | 'age';
}

export interface CaseStudy {
  id: string;
  name: string;
  location: string;
  year: number;
  summary: string;
  relevance: 'rejection_violence' | 'walking_home' | 'followed' | 'bystander_helped' | 'bystander_absent';
  sourceIds: string[];
}

export interface BehaviourFinding {
  id: string;
  finding: string;
  sourceId: string;
  confidence: 'data' | 'inferred';
}

export interface FiveD {
  key: 'distract' | 'delegate' | 'document' | 'delay' | 'direct';
  name: string;
  description: string;
  example: string;
}

export interface CalibrationParameter {
  key: string;
  value: number;
  range?: [number, number];
  basis: 'data' | 'inferred' | 'assumption';
  rationale: string;
  sourceIds: string[];
}

export interface SupportResource {
  name: string;
  description: string;
  url: string;
  phone?: string;
  region: 'us' | 'nyc' | 'uk' | 'international';
}

export interface Evidence {
  sources: Record<string, EvidenceSource>;
  stats: EvidenceStat[];
  caseStudies: CaseStudy[];
  harasserBehaviour: BehaviourFinding[];
  bystander: {
    fiveDs: FiveD[];
    findings: { id: string; finding: string; sourceId: string }[];
  };
  modelCalibration: { notes: string; parameters: CalibrationParameter[] };
  resources: SupportResource[];
}
