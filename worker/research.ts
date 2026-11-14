/**
 * Cited patterns the line writer, the live agent, the judge, and the debrief
 * all read. Numbers live only in data/harassment_research.json, each with a URL.
 * The sentence handed to a generative model has none, so it cannot invent one.
 */
import file from '../data/harassment_research.json';

export interface ResearchSource {
  id: string;
  title: string;
  publisher: string;
  year: number;
  url: string;
}

export interface ResearchClaim {
  id?: string;
  key?: string;
  name?: string;
  text: string;
  basis?: string;
  phrasing?: string[];
  sourceIds: string[];
}

export interface HarassmentResearch {
  compiled: string;
  limit: string;
  promptBrief: string;
  firmBystanderRule: string;
  sources: Record<string, ResearchSource>;
  behaviors: ResearchClaim[];
  responses: ResearchClaim[];
  fiveDs: ResearchClaim[];
  debrief: {
    noRightResponse: ResearchClaim;
    firmBoundary: ResearchClaim;
    fiveDCitation: ResearchClaim;
    bystanderStops: ResearchClaim;
  };
}

export const HARASSMENT_RESEARCH = file as HarassmentResearch;

/** Pasted into the line-model system prompt and the ElevenLabs agent prompt. */
export const PROMPT_BRIEF = HARASSMENT_RESEARCH.promptBrief;

/** Applied in code when a firm boundary and a bystander are both present. */
export const FIRM_BYSTANDER_RULE = HARASSMENT_RESEARCH.firmBystanderRule;

export function claimSources(claim: ResearchClaim): ResearchSource[] {
  return claim.sourceIds.map((id) => HARASSMENT_RESEARCH.sources[id]).filter(Boolean);
}
