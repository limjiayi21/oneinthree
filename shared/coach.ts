/**
 * The debrief coach (worker/coach/): a LangChain deep agent that writes a
 * personal debrief after Part 2 and answers follow-up questions.
 *
 *   POST /api/coach   CoachRequest -> application/x-ndjson stream of CoachEvent
 *
 * It only reads what the game already records (each session's summary). It is
 * off unless OPENAI_API_KEY is set on the Worker, and in the game it only runs
 * with ?coach=1.
 */

export const COACH_PATH = '/api/coach';

/** A file in the agent's working folder (its notes and the debrief). Sent back with a question so it keeps its notes. */
export interface CoachFile {
  path: string;
  content: string;
}

export interface CoachRequest {
  /** Part 2 (bystander) session: required. */
  bystander: string;
  /** Part 1 (her walk) session, when the player played it. */
  woman?: string;
  /** Absent: write the debrief. Present: answer this question about the run. */
  question?: string;
  /** The working folder from the debrief (returned in the 'done' event). */
  files?: CoachFile[];
}

export type CoachTodoStatus = 'pending' | 'in_progress' | 'completed';

export interface CoachTodo {
  content: string;
  status: CoachTodoStatus;
}

/** A piece of research the coach cited, resolved so the client can show it. */
export interface CoachCitation {
  id: string;
  headline?: string;
  text: string;
  source?: { publisher: string; year?: number; title?: string; url?: string };
}

export type CoachEvent =
  /** The coach's plan, every time it changes. */
  | { type: 'plan'; todos: CoachTodo[] }
  /** Something it is doing now, in plain words. `who` is the coach or one of its helpers. */
  | { type: 'step'; who: CoachWho; text: string }
  /** The finished debrief (markdown with [evidence_id] markers) or answer. */
  | { type: 'result'; kind: 'debrief' | 'answer'; markdown: string; citations: CoachCitation[]; checked: CheckSummary }
  /** The working folder, to send back with the next question. */
  | { type: 'done'; files: CoachFile[]; questionsLeft: number }
  | { type: 'error'; message: string };

export type CoachWho = 'coach' | 'moment-analyst' | 'evidence-researcher';

/** What the grounding check found on the final text. */
export interface CheckSummary {
  /** Numbers and citations that were checked against the research. */
  claims: number;
  /** Rounds the coach needed to fix problems the check found. */
  revisions: number;
  /** Sentences removed because they still could not be traced to the research. */
  removed: number;
}

/** Limits, shared so the client can say how many questions are left. */
/** The step the server sends when the first model failed and the backup takes over (the client gives it more time). */
export const COACH_BACKUP_STEP = 'The first model could not finish. Trying the backup';

export const COACH_LIMITS = {
  questionChars: 300,
  questionsPerRun: 6,
  filesBytes: 60_000,
} as const;
