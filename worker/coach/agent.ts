/**
 * The debrief coach: a LangChain deep agent (deepagents).
 *
 * The coach plans with a to-do list, delegates to two helpers, keeps notes in
 * its working folder, writes the debrief there and runs the grounding check on
 * its draft before it finishes:
 *
 *   coach                 plans, reads the run, picks the moments that matter,
 *                         writes /notes.md and /debrief.md, checks the draft
 *   ├─ moment-analyst     one moment: what you did, what it achieved, the risk,
 *   │                     the better options among the 5 Ds at that point
 *   └─ evidence-researcher  finds the research behind a point, word for word
 *
 * Every progress step is reported through `onEvent` so the player can watch
 * the plan tick off.
 */
import { createDeepAgent } from 'deepagents';
import { todoListMiddleware, type AgentMiddleware } from 'langchain';
import { tool } from '@langchain/core/tools';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { z } from 'zod';
import type { CoachEvent, CoachTodo, CoachWho } from '../../shared/coach';
import { EVIDENCE, searchPassages, type Embedder } from './knowledge';
import { checkText, formatProblems } from './check';
import { momentDetail, overview, type RunPart } from './run';

export interface CoachDeps {
  model: BaseChatModel;
  /** Extra agent middleware from the model setup (e.g. a fallback model). */
  middleware?: AgentMiddleware[];
  embed?: Embedder;
  parts: RunPart[];
  onEvent: (ev: CoachEvent) => void;
}

const SAFETY = `Safety rules (always):
- The player's own safety comes first. Never suggest physical intervention, chasing, or confronting him alone at length.
- Direct is the riskiest of the 5 Ds: when you discuss it, say how to keep it short and calm, and that it is fine to choose an indirect D.
- Never blame the woman or the player. Be honest about what a choice risked, kindly.
- Be exact about cause and effect: credit a result only to the moment it followed. If he had already given up or left before a choice, say the choice did not change the outcome.
- If the player seems upset or mentions real harm, point them to support and emergency services gently.`;

const CITING = `Citing research:
- Only the search_evidence tool and the five_ds_guide tool return citable passages. Cite them with their id in square brackets, e.g. [by_helped_25], right after the claim.
- Every number (a percentage, "1 in 3", any figure) must be copied exactly from a passage you cite in the same sentence. Never invent, round or combine numbers.
- Moment numbers and times from the run ("moment 2", "at 14s") are fine without citations.`;

export const COACH_PROMPT = `You are the debrief coach for "One in Three", a short first-person simulation about street harassment. In Part 1 the player lived it as the woman walking home; in Part 2 they were a bystander who saw it happen and could use the 5 Ds (Distract, Delegate, Document, Delay, Direct).

Your job: write this player's personal debrief for Part 2, grounded in what they actually did and in the research.

How to work (follow this order):
1. Call write_todos first with a short plan of 4 to 6 items, written for the player to read (plain words, e.g. "Look at what you did at each moment", "Find the research on asking staff for help"). Keep it updated: mark an item in_progress when you start it and completed when it is done.
2. Call get_my_run to see the outcome and every moment.
3. Choose the 2 or 3 moments that mattered most (always include the one that decided the outcome). Delegate each to the moment-analyst helper with the task tool, all in parallel, giving the part and moment number.
4. Delegate (do not search yourself) to the evidence-researcher helper the 1 or 2 points that need research behind them (e.g. "how often bystanders step in", "the risk of insulting a harasser").
5. Write your working notes to /notes.md (what you learned from the helpers, with passage ids).
6. Write the debrief to /debrief.md, then call check_draft with its full text. If the check reports problems, fix them by editing the file and check again until it passes.
7. Mark every to-do completed and finish with one short sentence.

The debrief (/debrief.md):
- 170 to 260 words, second person ("you"), warm and specific, no lecture.
- Markdown with exactly these three headings: "## What you did", "## What to try next time", "## What the research says".
- Refer to real moments ("when he blocked her path, you..."). Name the D each choice was.
- Under "What to try next time", give one or two concrete alternatives for a specific moment, with the exact words they could say.
- 2 to 4 citations in total.

${CITING}

${SAFETY}`;

export const FOLLOWUP_PROMPT = `You are the debrief coach for "One in Three", a first-person simulation about street harassment (Part 1: the player was the woman walking home; Part 2: a bystander who could use the 5 Ds). You already wrote this player's debrief; your notes are in /notes.md and the debrief in /debrief.md.

Answer the player's question about their run.
1. Call write_todos with a 2 or 3 item plan for answering.
2. Read /notes.md and /debrief.md. Use get_my_run, get_moment or the helpers if you need more.
3. Write your answer to /answer.md: under 150 words, plain, specific to their run, then call check_draft with it and fix any problems.
4. Finish with the answer text as your final message.
If the question is not about the simulation, harassment or helping others, say briefly what you can help with instead.

${CITING}

${SAFETY}`;

const ANALYST_PROMPT = `You analyse one moment of a player's run in a street-harassment simulation, for their debrief.
Given a part and moment number: call get_moment, then five_ds_guide, and search_evidence if a point needs research.
Reply in under 130 words with:
- What they did and which of the 5 Ds it was (or "none").
- What it achieved and what it risked.
- The best one or two alternatives at that exact moment, with the words they could have said.
- Up to two passage ids that support your points, each with its exact wording.
${CITING}
${SAFETY}`;

const RESEARCHER_PROMPT = `You find research for a debrief in a street-harassment simulation. For the point you are given, run two or three different search_evidence queries and return the 2 to 4 most relevant passages: their id, their exact wording, and one line on why each fits. Never paraphrase a number. If nothing fits, say so.`;

function tools(deps: CoachDeps, emit: (who: CoachWho, text: string) => void) {
  const getMyRun = tool(async () => overview(deps.parts), {
    name: 'get_my_run',
    description: "The player's run: each part's outcome, which of the 5 Ds the game saw, and one line per moment (numbered).",
    schema: z.object({}),
  });
  const getMoment = tool(async ({ part, n }) => momentDetail(deps.parts, part as 1 | 2, n), {
    name: 'get_moment',
    description: 'One moment in full: what was said just before, what the player said or did, what followed and why he reacted that way.',
    schema: z.object({ part: z.number().int().min(1).max(2).describe('1 = her walk, 2 = the bystander'), n: z.number().int().min(1).describe('moment number from get_my_run') }),
  });
  const searchEvidence = tool(
    async ({ query }) => {
      const { hits } = await searchPassages(query, 5, deps.embed);
      if (!hits.length) return 'No passages matched. Try other words.';
      return hits.map((p) => `[${p.id}] ${p.text}${p.detail ? `\n  (context, do not quote as a figure: ${p.detail})` : ''}`).join('\n');
    },
    {
      name: 'search_evidence',
      description: 'Search the research base (statistics on harassment, findings on harassers and bystanders, the 5 Ds). Returns passages with ids to cite.',
      schema: z.object({ query: z.string().min(2).max(200) }),
    },
  );
  const fiveDs = tool(async () => EVIDENCE.bystander.fiveDs.map((d) => `[five_d_${d.key}] ${d.name}: ${d.description} Example: ${d.example}`).join('\n'), {
    name: 'five_ds_guide',
    description: 'The 5 Ds of bystander intervention (Distract, Delegate, Document, Delay, Direct), with an example and the risk of each.',
    schema: z.object({}),
  });
  const checkDraft = tool(
    async ({ text }) => {
      emit('coach', 'Checking every number and citation against the research');
      const r = checkText(text);
      return r.ok ? `Passed: ${r.claims} claims checked, all traced to the research.` : `Failed. Fix these and check again:\n${formatProblems(r.problems)}`;
    },
    {
      name: 'check_draft',
      description: 'Check a draft before finishing: every citation must exist and every number must appear in a passage cited in the same sentence. Pass the full text.',
      schema: z.object({ text: z.string().min(1) }),
    },
  );
  return { getMyRun, getMoment, searchEvidence, fiveDs, checkDraft };
}

/** Turns the agent's tool calls into progress events the player can read. */
class Progress extends BaseCallbackHandler {
  name = 'coach-progress';
  private active = new Map<string, CoachWho>();
  constructor(private emitStep: (who: CoachWho, text: string) => void, private emitPlan: (todos: CoachTodo[]) => void) {
    super();
  }
  /** Which helper is running a tool: by the tool where only one helper has it, else by which helpers are active. */
  private who(tool: string): CoachWho {
    const helpers = new Set(this.active.values());
    if (!helpers.size) return 'coach';
    if (tool === 'get_moment' || tool === 'five_ds_guide') return 'moment-analyst';
    return helpers.has('evidence-researcher') ? 'evidence-researcher' : 'moment-analyst';
  }
  handleToolStart(_tool: unknown, input: string, runId: string, _parent?: string, _tags?: string[], _meta?: Record<string, unknown>, runName?: string): void {
    const name = runName ?? '';
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(input);
    } catch {
      /* some tools receive a plain string */
    }
    if (typeof (args as { input?: unknown }).input === 'string') {
      try {
        args = JSON.parse((args as { input: string }).input);
      } catch {
        /* keep */
      }
    }
    switch (name) {
      case 'write_todos': {
        const todos = Array.isArray(args.todos) ? (args.todos as CoachTodo[]) : [];
        if (todos.length) this.emitPlan(todos.map((t) => ({ content: String(t.content), status: t.status })));
        break;
      }
      case 'task': {
        const type = String(args.subagent_type ?? '');
        const who: CoachWho = type === 'evidence-researcher' ? 'evidence-researcher' : 'moment-analyst';
        this.active.set(runId, who);
        const desc = String(args.description ?? '').split(/[.\n]/)[0].slice(0, 90);
        this.emitStep('coach', who === 'moment-analyst' ? `Asked the moment analyst: ${desc}` : `Asked the evidence researcher: ${desc}`);
        break;
      }
      case 'get_my_run':
        this.emitStep('coach', 'Reading your run');
        break;
      case 'get_moment':
        this.emitStep(this.who(name), `Looking at moment ${args.n ?? ''} of Part ${args.part ?? 2}`);
        break;
      case 'five_ds_guide':
        this.emitStep(this.who(name), 'Weighing the 5 Ds at that moment');
        break;
      case 'search_evidence':
        this.emitStep(this.who(name), `Searching the research: "${String(args.query ?? '').slice(0, 70)}"`);
        break;
      case 'write_file':
      case 'edit_file': {
        const path = String(args.file_path ?? args.path ?? '');
        if (path.includes('notes')) this.emitStep('coach', 'Writing up notes');
        else if (path.includes('debrief')) this.emitStep('coach', name === 'edit_file' ? 'Revising the debrief' : 'Drafting your debrief');
        else if (path.includes('answer')) this.emitStep('coach', 'Writing the answer');
        break;
      }
      case 'read_file':
        this.emitStep('coach', 'Rereading its notes');
        break;
    }
  }
  handleToolEnd(_out: unknown, runId: string): void {
    this.active.delete(runId);
  }
  handleToolError(_err: unknown, runId: string): void {
    this.active.delete(runId);
  }
}

export function createCoachAgent(deps: CoachDeps, mode: 'debrief' | 'followup') {
  const emit = (who: CoachWho, text: string) => deps.onEvent({ type: 'step', who, text });
  const t = tools(deps, emit);
  const agent = createDeepAgent({
    model: deps.model,
    systemPrompt: mode === 'debrief' ? COACH_PROMPT : FOLLOWUP_PROMPT,
    tools: [t.getMyRun, t.getMoment, t.searchEvidence, t.fiveDs, t.checkDraft],
    middleware: [todoListMiddleware(), ...(deps.middleware ?? [])],
    subagents: [
      {
        name: 'moment-analyst',
        description: 'Analyses one moment of the run (give the part and moment number): what the player did, what it achieved and risked, and the best alternatives among the 5 Ds at that point.',
        systemPrompt: ANALYST_PROMPT,
        tools: [t.getMoment, t.fiveDs, t.searchEvidence],
        middleware: deps.middleware,
      },
      {
        name: 'evidence-researcher',
        description: 'Finds the research behind one point (give the point in plain words). Returns passage ids with their exact wording.',
        systemPrompt: RESEARCHER_PROMPT,
        tools: [t.searchEvidence],
        middleware: deps.middleware,
      },
    ],
  });
  const progress = new Progress(emit, (todos) => deps.onEvent({ type: 'plan', todos }));
  return { agent, progress };
}
