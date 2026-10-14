import { describe, expect, it } from 'vitest';
import {
  choose,
  fisherExact,
  lcsLength,
  mean,
  median,
  permutationPValue,
  relativeChange,
  sd,
  sequenceSimilarity,
  summarize,
} from '../src/diff/stats.js';

describe('descriptive stats', () => {
  it.each([
    [[1, 2, 3, 4], 2.5, 2.5],
    [[5], 5, 5],
    [[1, 100, 3], 104 / 3, 3],
  ])('mean/median of %j', (xs, m, med) => {
    expect(mean(xs)).toBeCloseTo(m, 9);
    expect(median(xs)).toBeCloseTo(med, 9);
  });
  it('sd uses n-1 and is 0 for one sample', () => {
    expect(sd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138089935, 6);
    expect(sd([3])).toBe(0);
  });
  it('summarize handles empty input without throwing', () => {
    expect(summarize([]).n).toBe(0);
  });
});

describe('choose', () => {
  it.each([
    [6, 3, 20],
    [8, 4, 70],
    [5, 0, 1],
    [5, 6, 0],
  ])('C(%i,%i)=%i', (n, k, v) => {
    expect(choose(n, k)).toBe(v);
  });
});

describe('permutationPValue (exact)', () => {
  // [a, b, expected p]
  const table: Array<[number[], number[], number]> = [
    [[1, 2, 3], [4, 5, 6], 0.1], // best possible at 3 vs 3
    [[1, 2, 3, 4], [5, 6, 7, 8], 2 / 70],
    [[1, 2, 3], [1, 2, 3], 1],
    [[1, 2, 3], [3, 2, 1], 1],
    [[5], [5], 1],
    [[1], [100], 1], // 1 vs 1 can never be significant
    [[1, 1, 1], [9, 9, 9], 0.1],
  ];
  it.each(table)('%j vs %j -> %d', (a, b, p) => {
    expect(permutationPValue(a, b)).toBeCloseTo(p, 9);
  });
  it('returns null for an empty group', () => {
    expect(permutationPValue([], [1])).toBeNull();
  });
  it('is symmetric', () => {
    expect(permutationPValue([1, 2, 9], [4, 5, 6, 7])).toBeCloseTo(
      permutationPValue([4, 5, 6, 7], [1, 2, 9])!,
      9,
    );
  });
  it('Monte Carlo path is deterministic for a given seed and close to the truth', () => {
    const a = Array.from({ length: 12 }, (_, i) => i);
    const b = Array.from({ length: 12 }, (_, i) => i + 20);
    const p1 = permutationPValue(a, b, { maxExact: 10, seed: 7, samples: 4000 })!;
    const p2 = permutationPValue(a, b, { maxExact: 10, seed: 7, samples: 4000 })!;
    expect(p1).toBe(p2);
    expect(p1).toBeLessThan(0.01);
  });
});

describe('fisherExact', () => {
  // [aSucc, aN, bSucc, bN, expected p]
  const table: Array<[number, number, number, number, number]> = [
    [3, 3, 0, 3, 0.1],
    [4, 4, 0, 4, 2 / 70],
    [2, 4, 2, 4, 1],
    [1, 1, 0, 1, 1],
    [10, 10, 0, 10, 2 / 184756],
    [5, 5, 5, 5, 1],
  ];
  it.each(table)('%i/%i vs %i/%i -> %d', (as, an, bs, bn, p) => {
    expect(fisherExact(as, an, bs, bn)).toBeCloseTo(p, 8);
  });
  it('returns null for an empty group', () => {
    expect(fisherExact(0, 0, 1, 2)).toBeNull();
  });
});

describe('relativeChange', () => {
  it.each([
    [100, 150, 0.5],
    [100, 50, -0.5],
  ])('%d -> %d', (a, b, r) => {
    expect(relativeChange(a, b)).toBeCloseTo(r, 9);
  });
  it('is null when the base is zero or not finite', () => {
    expect(relativeChange(0, 5)).toBeNull();
    expect(relativeChange(NaN, 5)).toBeNull();
  });
});

describe('sequence similarity', () => {
  it.each([
    [['a', 'b', 'c'], ['a', 'b', 'c'], 3, 1],
    [['a', 'b', 'c'], ['a', 'c'], 2, 0.8],
    [['a', 'b'], ['c', 'd'], 0, 0],
    [[], [], 0, 1],
    [['a'], [], 0, 0],
  ] as const)('%j vs %j', (a, b, lcs, sim) => {
    expect(lcsLength(a, b)).toBe(lcs);
    expect(sequenceSimilarity(a, b)).toBeCloseTo(sim, 9);
  });
});
