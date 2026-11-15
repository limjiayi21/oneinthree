/**
 * The grounding check the coach must pass before anything reaches the player
 * (the same rule as the rest of the game: every figure traces to
 * content/evidence.json).
 *
 *   - every [citation] must be a real passage id;
 *   - every figure (a percentage, "1 in 3", a number of two or more digits)
 *     must appear in a passage cited in the same sentence.
 *
 * Times and moment numbers from the run ("moment 3", "at 12s", "Part 2",
 * "the 5 Ds") are not figures.
 */
import { PASSAGE_BY_ID, type Passage } from './knowledge';

export interface CheckProblem {
  sentence: string;
  issue: string;
}

export interface CheckResult {
  ok: boolean;
  claims: number;
  problems: CheckProblem[];
  cited: string[];
}

const WORD_NUM: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };

const CITE = /\[([a-z0-9_]+)\]/gi;

/** Figures in a sentence, normalised ("one in three" -> "1 in 3", "25 percent" -> "25%"). */
export function figures(sentence: string): string[] {
  const s = sentence
    .replace(CITE, ' ')
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+in\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/gi, (_, a: string, b: string) => `${WORD_NUM[a.toLowerCase()]} in ${WORD_NUM[b.toLowerCase()] ?? b}`)
    .replace(/(\d)\s*(?:per\s?cent|percent)\b/gi, '$1%');
  const out: string[] = [];
  const re = /(\d+(?:\.\d+)?%)|(\d+\s+in\s+\d+)|(\d{1,3}(?:,\d{3})+|\d{2,}(?:\.\d+)?)/gi;
  for (const m of s.matchAll(re)) {
    const at = m.index ?? 0;
    const before = s.slice(Math.max(0, at - 12), at).toLowerCase();
    const after = s.slice(at + m[0].length, at + m[0].length + 9).toLowerCase();
    if (!m[1] && !m[2]) {
      // a time, a moment or a part of the game, not a statistic
      if (/^\s*(s\b|sec|second|minute)/.test(after) || /(moment|part|at|step)\s*$/.test(before)) continue;
      if (/^\s*(ds?\b)/.test(after)) continue;
    }
    out.push(m[0].replace(/,/g, '').replace(/\s+/g, ' ').toLowerCase());
  }
  return out;
}

const passageHas = (p: Passage, fig: string): boolean => {
  const hay = `${p.text} ${p.detail ?? ''}`.replace(/,/g, '').replace(/(\d)\s*(?:per\s?cent|percent)\b/gi, '$1%').toLowerCase();
  if (fig.endsWith('%')) return hay.includes(fig);
  return new RegExp(`(^|[^0-9.])${fig.replace(/\./g, '\\.')}([^0-9]|$)`).test(hay);
};

/** Sentences of a markdown text (headings and list items count as sentences). */
export function sentences(markdown: string): string[] {
  return markdown
    .split(/\n+/)
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z"“‘(\[*])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function checkText(markdown: string): CheckResult {
  const problems: CheckProblem[] = [];
  const cited = new Set<string>();
  let claims = 0;
  for (const sentence of sentences(markdown)) {
    const ids = [...sentence.matchAll(CITE)].map((m) => m[1]);
    const known: Passage[] = [];
    for (const id of ids) {
      claims++;
      const p = PASSAGE_BY_ID.get(id);
      if (!p) problems.push({ sentence, issue: `[${id}] is not in the research base` });
      else {
        known.push(p);
        cited.add(id);
      }
    }
    for (const fig of figures(sentence)) {
      claims++;
      if (!known.some((p) => passageHas(p, fig))) {
        problems.push({ sentence, issue: known.length ? `"${fig}" does not appear in ${ids.map((i) => `[${i}]`).join(' ')}` : `"${fig}" has no citation` });
      }
    }
  }
  return { ok: problems.length === 0, claims, problems, cited: [...cited] };
}

/** Last resort: drop the sentences that still fail. */
export function removeProblems(markdown: string, problems: CheckProblem[]): { markdown: string; removed: number } {
  let out = markdown;
  const bad = [...new Set(problems.map((p) => p.sentence))];
  for (const s of bad) out = out.replace(s, '');
  out = out
    .split('\n')
    .map((l) => l.replace(/\s{2,}/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { markdown: out, removed: bad.length };
}

export function formatProblems(problems: CheckProblem[]): string {
  return problems.map((p, i) => `${i + 1}. ${p.issue}\n   in: "${p.sentence}"`).join('\n');
}
