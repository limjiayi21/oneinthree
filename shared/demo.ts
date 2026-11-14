/** The seed `?demo=1` always uses, so a demo run takes the same decisions. */
export const DEMO_SEED = 20261114;

/**
 * `?seed=` wins when it is a finite number. Otherwise `?demo=1` uses DEMO_SEED.
 * Anything else leaves the session to draw its own seed.
 */
export function resolveSeed(query: { seed?: string | null; demo?: string | null }): number | undefined {
  if (query.seed != null && query.seed !== '' && Number.isFinite(Number(query.seed))) return Number(query.seed);
  if (query.demo === '1' || query.demo === 'true') return DEMO_SEED;
  return undefined;
}
