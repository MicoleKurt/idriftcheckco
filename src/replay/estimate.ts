import { estimateCostUsd, lookupPrice, type Price } from '../trace/pricing.js';
import type { Trace, Variant } from '../trace/schema.js';

export interface ArmEstimate {
  arm: string;
  model: string | undefined;
  runs: number;
  /** Estimated cost for all runs of this arm, or null when the model has no known price. */
  costUsd: number | null;
  lowUsd: number | null;
  highUsd: number | null;
}

export interface ReplayEstimate {
  arms: ArmEstimate[];
  totalUsd: number | null;
  lowUsd: number | null;
  highUsd: number | null;
  /** Estimated wall-clock minutes if run sequentially, or null if the source has no duration. */
  minutes: number | null;
  caveats: string[];
}

/** A new model can use quite different token counts; show an honest band, not a point. */
const LOW = 0.5;
const HIGH = 2;

/**
 * Estimate the cost of a replay BEFORE spending anything, by pricing the source
 * session's token profile at each arm's model. This is an estimate: a different
 * model may take more or fewer steps.
 */
export function estimateReplay(
  source: Trace,
  arms: Array<{ name: string; variant: Variant; runs: number }>,
  prices: Record<string, Price> = {},
  options: { allTurns?: boolean } = {},
): ReplayEstimate {
  const caveats = [
    'Estimate prices the original session\'s token usage at each model; a different model may use 0.5x to 2x as many tokens.',
  ];
  const out: ArmEstimate[] = arms.map((a) => {
    const model = a.variant.model ?? source.model;
    const one = estimateCostUsd(model, source.usage, prices);
    if (one === null) caveats.push(`No price known for "${model ?? 'unknown model'}"; its cost is excluded. Add it under \`prices\` in the config.`);
    return {
      arm: a.name,
      model,
      runs: a.runs,
      costUsd: one === null ? null : one * a.runs,
      lowUsd: one === null ? null : one * a.runs * LOW,
      highUsd: one === null ? null : one * a.runs * HIGH,
    };
  });
  const known = out.filter((a) => a.costUsd !== null);
  const sum = (f: (a: ArmEstimate) => number | null) => (known.length ? known.reduce((s, a) => s + (f(a) ?? 0), 0) : null);
  const totalRuns = arms.reduce((s, a) => s + a.runs, 0);
  if (source.humanTurns > 1 && !options.allTurns) caveats.push(`The source session had ${source.humanTurns} human turns; only the first task is replayed, so real cost is likely lower.`);
  if (lookupPrice(source.model, prices) === undefined && source.model) caveats.push(`Source model "${source.model}" has no known price.`);
  return {
    arms: out,
    totalUsd: sum((a) => a.costUsd),
    lowUsd: sum((a) => a.lowUsd),
    highUsd: sum((a) => a.highUsd),
    minutes: source.durationMs === null ? null : Math.round((source.durationMs * totalRuns) / 60_000),
    caveats,
  };
}
