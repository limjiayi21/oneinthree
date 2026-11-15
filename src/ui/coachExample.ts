/**
 * What the coach writes, as an example: shown instead of an error when the live coach cannot finish
 * (or takes too long), clearly marked as an example rather than a reading of this player's run.
 * Citations are real entries in content/evidence.json, resolved the same way the live coach's are.
 */
import type { CoachCitation } from '../../shared/coach';
import type { Evidence } from '../../shared/evidence';
import { resolveSources, resolveStats } from './evidence';

export const EXAMPLE_DEBRIEF = `## What you did

*This is an example of what the coach writes. The live coach could not finish your debrief this time, so this one is not about your run.*

You noticed early that she did not know him, and you did not wait for someone else to act. That matters: only a quarter of people harassed in public say anyone helped them [loreal_helped_25].

When he blocked her path, you spoke to her, not to him. A friendly question gave her a reason to turn away from him without making him lose face in front of you.

## What to try next time

- **Distract first.** Something ordinary to her: *"Hey, sorry I'm late. Ready?"* It is the lowest-risk way in.
- **Bring someone else in.** The shopkeeper was a few metres away: *"Can you come out here? He won't leave her alone."*
- **Check in afterwards.** Once he has gone: *"Are you okay? Do you want me to walk with you?"* It is always open to you, even if you froze.

## What the research says

Bystanders are often around when this happens: about a third of street harassment incidents in New York had people nearby [nyc_bystanders_present_31]. And when there is a conflict in public, someone usually does step in: in 9 of 10 cases caught on camera, at least one bystander intervened [cctv_9in10]. You are rarely the only one who can help, and you are rarely the only one who will.
`;

const IDS = ['loreal_helped_25', 'nyc_bystanders_present_31', 'cctv_9in10'];

/** The example's citations, in the shape the live coach sends. */
export function exampleCitations(evidence: Evidence): CoachCitation[] {
  return resolveStats(evidence, IDS).map((stat) => {
    const src = resolveSources(evidence, [stat.sourceId])[0];
    return {
      id: stat.id,
      headline: stat.headline,
      text: `${stat.headline} ${stat.text}`.trim(),
      source: src ? { publisher: src.publisher || src.title || '', year: src.year, title: src.title, url: src.url } : undefined,
    };
  });
}
