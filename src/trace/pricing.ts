import type { Usage } from './schema.js';

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write. */
  cacheWrite: number;
}

/**
 * Prices published by the model provider as of {@link PRICES_AS_OF}.
 * `input`/`output` (and `cacheRead` where stated) are taken from the provider's
 * published table. `cacheWrite` is NOT published per model in our source, so it
 * is assumed to be 1.25x input (the long-standing 5-minute write multiplier).
 * Estimates are therefore labelled "estimated" everywhere they are shown, and
 * users can override any entry in the config file.
 */
export const PRICES_AS_OF = '2026-10-06';

function p(input: number, output: number, cacheRead = input * 0.1): Price {
  return { input, output, cacheRead, cacheWrite: input * 1.25 };
}

export const DEFAULT_PRICES: Record<string, Price> = {
  'claude-fable-5-1': p(10, 50, 0.25),
  'claude-fable-5': p(10, 50, 0.25),
  'claude-opus-5-5': p(4, 20, 0.2),
  'claude-opus-5': p(5, 25),
  'claude-opus-4-8': p(5, 25),
  'claude-opus-4-7': p(5, 25),
  'claude-opus-4-6': p(5, 25),
  'claude-sonnet-5-5': p(2, 10, 0.2),
  'claude-sonnet-5': p(2, 10),
  'claude-sonnet-4-6': p(3, 15),
  'claude-haiku-5-5': p(0.1, 0.5),
  'claude-haiku-4-5': p(1, 5),
};

/** Strip date suffixes / context-window tags so `claude-haiku-4-5-20251001[1m]` resolves. */
export function normalizeModelId(model: string): string {
  return model
    .toLowerCase()
    .replace(/\[.*?\]$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/@\d{8}$/, '');
}

export function lookupPrice(
  model: string | undefined,
  overrides: Record<string, Price> = {},
): Price | undefined {
  if (!model) return undefined;
  const id = normalizeModelId(model);
  return overrides[id] ?? DEFAULT_PRICES[id];
}

/** Estimated USD cost for a usage record, or `null` when the model has no known price. */
export function estimateCostUsd(
  model: string | undefined,
  usage: Usage,
  overrides: Record<string, Price> = {},
): number | null {
  const price = lookupPrice(model, overrides);
  if (!price) return null;
  const cost =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export function totalTokens(u: Usage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}
