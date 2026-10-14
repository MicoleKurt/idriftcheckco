import { describe, expect, it } from 'vitest';
import { estimateCostUsd, lookupPrice, normalizeModelId } from '../src/trace/pricing.js';

const usage = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 0,
};

describe('pricing', () => {
  it('normalizes date suffixes and context tags', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
  });
  it('estimates cost from the table', () => {
    // opus-5-5: 4 + 20 + 0.2
    expect(estimateCostUsd('claude-opus-5-5', usage)).toBeCloseTo(24.2, 6);
  });
  it('returns null for unknown models instead of guessing', () => {
    expect(estimateCostUsd('some-future-model', usage)).toBeNull();
    expect(estimateCostUsd(undefined, usage)).toBeNull();
  });
  it('honours overrides', () => {
    const prices = { 'my-model': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
    expect(lookupPrice('my-model', prices)?.output).toBe(2);
    expect(estimateCostUsd('my-model', usage, prices)).toBeCloseTo(3, 6);
  });
});
