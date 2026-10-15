import { minRunsForSignificance } from './diff.js';
import type { DiffReport } from './types.js';

/**
 * Group-sequential testing for `--runs auto`.
 *
 * Instead of always paying for the maximum number of runs, the replay looks at the data
 * at a few planned points and stops as soon as the answer is clear. Looking repeatedly
 * inflates false positives unless the significance level is split across looks, so we
 * use Bonferroni alpha spending: K planned looks, each tested at alpha / K. It is
 * conservative (never more false positives than alpha overall) and easy to explain.
 */
export interface LookPlan {
  /** Runs per side at which the data is examined, ascending; the last is the maximum. */
  looks: number[];
  /** Significance level applied at every look (alpha / number of looks). */
  alphaPerLook: number;
  maxRuns: number;
}

/**
 * The smallest consistent plan: K looks where the first look is the fewest runs at which
 * alpha / K is reachable at all, then one look every 2 runs, plus a final look at maxRuns.
 * For alpha 0.05 and maxRuns 8 this is looks at 5, 7 and 8 runs, each at alpha 0.0167.
 */
export function planLooks(alpha: number, maxRuns: number): LookPlan {
  for (let k = 1; k <= maxRuns; k++) {
    const perLook = alpha / k;
    const first = minRunsForSignificance(perLook);
    if (first > maxRuns) break;
    const looks: number[] = [];
    for (let n = first; n < maxRuns; n += 2) looks.push(n);
    looks.push(maxRuns);
    if (looks.length === k) return { looks, alphaPerLook: perLook, maxRuns };
  }
  // No consistent multi-look plan (maxRuns too small): a single look at the end.
  return { looks: [maxRuns], alphaPerLook: alpha, maxRuns };
}

export type StopReason = 'confirmed-regression' | 'no-signal' | 'max-runs' | 'continue';

/**
 * Decide after a look. The report must have been computed at `alphaPerLook`, so a
 * `strong` finding means p < alpha / K.
 *
 * - A confirmed hard regression stops immediately: more runs cannot un-confirm it within
 *   the plan's error guarantee.
 * - No adverse effect at all, not even a weak one, stops too: stopping early can only cost
 *   power for effects the data shows no sign of, never add false positives.
 * - Anything in between continues to the next look, up to the maximum.
 */
export function decideStop(report: DiffReport, isLastLook: boolean): StopReason {
  const adverse = report.findings.filter((f) => f.direction !== 'better');
  if (adverse.some((f) => f.severity === 'hard' && f.evidence === 'strong')) return 'confirmed-regression';
  if (adverse.length === 0) return 'no-signal';
  return isLastLook ? 'max-runs' : 'continue';
}

export function describeStop(reason: StopReason, runs: number, plan: LookPlan): string {
  const design = `looks at ${plan.looks.join(', ')} runs per side, alpha ${plan.alphaPerLook.toFixed(4)} each`;
  switch (reason) {
    case 'confirmed-regression':
      return `Adaptive runs: stopped at ${runs} of ${plan.maxRuns} per side, regression confirmed (${design}).`;
    case 'no-signal':
      return `Adaptive runs: stopped at ${runs} of ${plan.maxRuns} per side, no sign of a difference (${design}).`;
    case 'max-runs':
      return `Adaptive runs: used all ${plan.maxRuns} runs per side, the evidence stayed mixed (${design}).`;
    default:
      return `Adaptive runs: ${design}.`;
  }
}
