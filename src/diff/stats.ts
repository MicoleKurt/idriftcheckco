/**
 * Small-sample statistics. Agent evals run 3 to 10 times, so everything here is
 * distribution-free and exact where feasible. No dependencies.
 */

export interface Summary {
  n: number;
  mean: number;
  median: number;
  sd: number;
  min: number;
  max: number;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Sample standard deviation (n-1); 0 for a single observation. */
export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

export function summarize(xs: readonly number[]): Summary {
  return {
    n: xs.length,
    mean: mean(xs),
    median: median(xs),
    sd: sd(xs),
    min: xs.length ? Math.min(...xs) : NaN,
    max: xs.length ? Math.max(...xs) : NaN,
  };
}

/** Deterministic PRNG so Monte Carlo p-values are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Binomial coefficient as a float (exact below 2^53, ample for our sizes). */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

const EPS = 1e-9;

export interface PermutationOptions {
  seed?: number;
  /** Enumerate exactly when C(n,k) is at most this; otherwise sample. */
  maxExact?: number;
  samples?: number;
}

/**
 * Two-sided permutation test on the absolute difference of means.
 * Returns `null` when either group is empty (nothing to compare).
 * Exact for small groups, so the minimum attainable p-value is honest:
 * 3 vs 3 can never go below 0.1.
 */
export function permutationPValue(
  a: readonly number[],
  b: readonly number[],
  opts: PermutationOptions = {},
): number | null {
  const na = a.length;
  const nb = b.length;
  if (na === 0 || nb === 0) return null;
  const all = [...a, ...b];
  const n = all.length;
  const total = all.reduce((s, x) => s + x, 0);
  const observed = Math.abs(mean(a) - mean(b));
  const stat = (sumA: number) => Math.abs(sumA / na - (total - sumA) / nb);

  const combos = choose(n, na);
  const maxExact = opts.maxExact ?? 20_000;
  let extreme = 0;
  let count = 0;

  if (combos <= maxExact) {
    // Enumerate every way to choose which observations form "group A".
    const rec = (start: number, left: number, sum: number): void => {
      if (left === 0) {
        count++;
        if (stat(sum) >= observed - EPS) extreme++;
        return;
      }
      for (let i = start; i <= n - left; i++) rec(i + 1, left - 1, sum + all[i]!);
    };
    rec(0, na, 0);
  } else {
    const rand = mulberry32(opts.seed ?? 1);
    const samples = opts.samples ?? 10_000;
    const idx = all.map((_, i) => i);
    for (let s = 0; s < samples; s++) {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [idx[i], idx[j]] = [idx[j]!, idx[i]!];
      }
      let sum = 0;
      for (let i = 0; i < na; i++) sum += all[idx[i]!]!;
      count++;
      if (stat(sum) >= observed - EPS) extreme++;
    }
    // Add-one smoothing keeps Monte Carlo p-values strictly positive.
    return (extreme + 1) / (count + 1);
  }
  return extreme / count;
}

function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/**
 * Fisher's exact test (two-sided) for `aSuccess/aTotal` versus `bSuccess/bTotal`.
 * Returns `null` if either group is empty.
 */
export function fisherExact(
  aSuccess: number,
  aTotal: number,
  bSuccess: number,
  bTotal: number,
): number | null {
  if (aTotal === 0 || bTotal === 0) return null;
  const successes = aSuccess + bSuccess;
  const n = aTotal + bTotal;
  const logPmf = (x: number) =>
    logFactorial(aTotal) +
    logFactorial(bTotal) +
    logFactorial(successes) +
    logFactorial(n - successes) -
    logFactorial(n) -
    logFactorial(x) -
    logFactorial(aTotal - x) -
    logFactorial(successes - x) -
    logFactorial(bTotal - (successes - x));
  const observed = logPmf(aSuccess);
  const lo = Math.max(0, successes - bTotal);
  const hi = Math.min(aTotal, successes);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const lp = logPmf(x);
    if (lp <= observed + 1e-9) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

/** Relative change from `base` to `next`; `null` when base is 0 or non-finite. */
export function relativeChange(base: number, next: number): number | null {
  if (!Number.isFinite(base) || !Number.isFinite(next) || base === 0) return null;
  return (next - base) / Math.abs(base);
}

/** Longest common subsequence length. */
export function lcsLength<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Dice-style sequence similarity in [0,1]: 2*LCS/(|a|+|b|); two empty sequences are identical. */
export function sequenceSimilarity<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  return (2 * lcsLength(a, b)) / (a.length + b.length);
}
