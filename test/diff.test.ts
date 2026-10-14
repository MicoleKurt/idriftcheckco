import { describe, expect, it } from 'vitest';
import { decideVerdict, diffGroups, diffTraces, exitCodeFor, minRunsForSignificance } from '../src/diff/diff.js';
import type { Finding, Verdict } from '../src/diff/types.js';
import { FIX_AND_TEST, many, mk, type Call, type MkOptions } from './helpers.js';

const find = (r: ReturnType<typeof diffGroups>, id: string) => r.findings.find((f) => f.id === id);

interface Scenario {
  name: string;
  baseline: MkOptions[];
  candidate: MkOptions[];
  verdict: Verdict;
  /** finding ids that must be present */
  has?: string[];
  /** finding ids that must be absent */
  lacks?: string[];
}

const same = (n: number, o: MkOptions = {}): MkOptions[] => Array.from({ length: n }, () => ({ calls: FIX_AND_TEST, ...o }));

const scenarios: Scenario[] = [
  {
    name: 'identical single runs',
    baseline: same(1),
    candidate: same(1),
    verdict: 'no-change',
  },
  {
    name: 'single run: candidate stops editing the file (unanimous, untestable) -> weak hard',
    baseline: same(1),
    candidate: [{ calls: [['Read', 'src/a.ts'], ['Bash', 'pnpm test']] }],
    verdict: 'likely-regression',
    has: ['file-missing:src/a.ts'],
  },
  {
    name: '4 vs 4: candidate never edits the file -> strong regression',
    baseline: same(4),
    candidate: same(4, { calls: [['Read', 'src/a.ts'], ['Bash', 'pnpm test']] }),
    verdict: 'regression',
    has: ['file-missing:src/a.ts'],
  },
  {
    name: '3 vs 3: same separation can only be weak (p floor is 0.1)',
    baseline: same(3),
    candidate: same(3, { calls: [['Read', 'src/a.ts'], ['Bash', 'pnpm test']] }),
    verdict: 'likely-regression',
  },
  {
    name: 'candidate edits an extra file',
    baseline: same(4),
    candidate: same(4, { calls: [...FIX_AND_TEST, ['Write', 'src/new.ts']] }),
    verdict: 'regression',
    has: ['file-unexpected:src/new.ts'],
  },
  {
    name: 'file changed in only half of candidate runs is below the reporting bar',
    baseline: same(4),
    candidate: [
      ...same(2),
      ...same(2, { calls: [['Read', 'src/a.ts'], ['Bash', 'pnpm test']] }),
    ],
    verdict: 'likely-regression',
  },
  {
    name: 'file changed in 3/4 candidate runs vs 4/4 is not reported',
    baseline: same(4),
    candidate: [...same(3), ...same(1, { calls: [['Read', 'src/a.ts'], ['Bash', 'pnpm test']] })],
    verdict: 'no-change',
    lacks: ['file-missing:src/a.ts'],
  },
  {
    name: 'reordered reads are noise',
    baseline: same(3, { calls: [['Read', 'a.ts'], ['Read', 'b.ts'], ['Edit', 'a.ts'], ['Bash', 'pnpm test']] }),
    candidate: same(3, { calls: [['Read', 'b.ts'], ['Read', 'a.ts'], ['Edit', 'a.ts'], ['Bash', 'pnpm test']] }),
    verdict: 'no-change',
  },
  {
    name: 'cost +100% completely separated at n=4 -> strong drift',
    baseline: same(4, { costUsd: 0.1 }),
    candidate: same(4, { costUsd: 0.2 }),
    verdict: 'drift',
    has: ['metric:costUsd'],
  },
  {
    name: 'cost +100% at n=3 -> only possible drift (cannot reach p<0.05)',
    baseline: same(3, { costUsd: 0.1 }),
    candidate: same(3, { costUsd: 0.2 }),
    verdict: 'possible-drift',
  },
  {
    name: 'cost halves -> improvement is reported but never worsens the verdict',
    baseline: same(4, { costUsd: 0.2 }),
    candidate: same(4, { costUsd: 0.1 }),
    verdict: 'no-change',
    has: ['metric:costUsd'],
  },
  {
    name: 'overlapping cost distributions are noise',
    baseline: [0.1, 0.2, 0.15, 0.3].map((c) => ({ calls: FIX_AND_TEST, costUsd: c })),
    candidate: [0.12, 0.25, 0.18, 0.28].map((c) => ({ calls: FIX_AND_TEST, costUsd: c })),
    verdict: 'no-change',
  },
  {
    name: 'tiny absolute cost change below the floor is ignored',
    baseline: same(4, { costUsd: 0.001 }),
    candidate: same(4, { costUsd: 0.004 }),
    verdict: 'no-change',
  },
  {
    name: 'candidate drops the test run -> verification-dropped (soft, strong at n=4)',
    baseline: same(4),
    candidate: same(4, { calls: [['Read', 'src/a.ts'], ['Edit', 'src/a.ts']] }),
    verdict: 'drift',
    has: ['verification-dropped:exec:pnpm test'],
  },
  {
    name: 'agent stops finishing',
    baseline: same(4, { status: 'completed' }),
    candidate: same(4, { status: 'error' }),
    verdict: 'regression',
    has: ['completion'],
  },
  {
    name: 'completion improves -> no finding',
    baseline: same(4, { status: 'error' }),
    candidate: same(4, { status: 'completed' }),
    verdict: 'no-change',
    lacks: ['completion'],
  },
  {
    name: 'user check command starts failing',
    baseline: same(4, { check: { command: 'pnpm test', exitCode: 0 } }),
    candidate: same(4, { check: { command: 'pnpm test', exitCode: 1 } }),
    verdict: 'regression',
    has: ['check'],
  },
  {
    name: 'check present on one side only is not compared',
    baseline: same(4, { check: { command: 'pnpm test', exitCode: 0 } }),
    candidate: same(4),
    verdict: 'no-change',
    lacks: ['check'],
  },
  {
    name: 'new tool errors are soft drift',
    baseline: same(4),
    candidate: same(4, {
      calls: [...FIX_AND_TEST, ['Bash', 'ls', false], ['Bash', 'ls', false]] as Call[],
    }),
    verdict: 'drift',
    has: ['metric:toolErrors'],
  },
];

describe('diffGroups (table-driven)', () => {
  it.each(scenarios)('$name', (s) => {
    const r = diffGroups(s.baseline.map((o) => mk(o)), s.candidate.map((o) => mk(o)));
    expect(r.verdict).toBe(s.verdict);
    for (const id of s.has ?? []) expect(find(r, id), `expected finding ${id}`).toBeDefined();
    for (const id of s.lacks ?? []) expect(find(r, id), `unexpected finding ${id}`).toBeUndefined();
  });
});

describe('diffGroups details', () => {
  it('throws a helpful error on an empty side', () => {
    expect(() => diffGroups([], [mk()])).toThrow(/at least one run/);
  });

  it('a strong file finding carries an exact p-value', () => {
    const r = diffGroups(many(4, { calls: FIX_AND_TEST }), many(4, { calls: [['Bash', 'pnpm test']] }));
    const f = find(r, 'file-missing:src/a.ts')!;
    expect(f.evidence).toBe('strong');
    expect(f.p).toBeCloseTo(2 / 70, 6);
  });

  it('hard findings sort before soft, strong before weak', () => {
    const r = diffGroups(
      many(4, { calls: FIX_AND_TEST, costUsd: 0.1 }),
      many(4, { calls: [['Bash', 'pnpm test']], costUsd: 0.5 }),
    );
    const sev = r.findings.map((f) => f.severity);
    expect(sev.indexOf('hard')).toBeLessThan(sev.indexOf('soft'));
  });

  it('explains the sample-size limit when n is too small', () => {
    const r = diffTraces(mk({ calls: FIX_AND_TEST }), mk({ calls: FIX_AND_TEST }));
    expect(r.notes.join(' ')).toMatch(/Use --runs 4/);
  });

  it('does not nag about sample size when n is sufficient', () => {
    const r = diffGroups(many(4, { calls: FIX_AND_TEST }), many(4, { calls: FIX_AND_TEST }));
    expect(r.notes.join(' ')).not.toMatch(/--runs/);
  });

  it('computes a noise floor from baseline self-similarity', () => {
    const r = diffGroups(many(3, { calls: FIX_AND_TEST }), many(3, { calls: FIX_AND_TEST }));
    expect(r.sequence.within).toBe(1);
    expect(r.sequence.across).toBe(1);
  });

  it('flags a changed order of work only when it exceeds the noise floor', () => {
    const a: Call[] = [['Edit', 'a.ts'], ['Bash', 'pnpm test'], ['Edit', 'b.ts'], ['Bash', 'pnpm build']];
    const b: Call[] = [['Bash', 'git status'], ['Bash', 'npm install'], ['Edit', 'c.ts'], ['Bash', 'node x.js']];
    const r = diffGroups(many(3, { calls: a }), many(3, { calls: b }));
    expect(find(r, 'sequence')).toBeDefined();
  });

  it('does not mutate its inputs', () => {
    const base = many(2, { calls: FIX_AND_TEST });
    const snap = JSON.stringify(base);
    diffGroups(base, many(2, { calls: FIX_AND_TEST }));
    expect(JSON.stringify(base)).toBe(snap);
  });

  it('is deterministic', () => {
    const a = many(5, { costUsd: 0.1 });
    const b = many(5, { costUsd: 0.3 });
    expect(JSON.stringify(diffGroups(a, b))).toBe(JSON.stringify(diffGroups(a, b)));
  });

  it('skips cost metric when cost is unknown', () => {
    const noCost = (o: MkOptions) => ({ ...mk(o), costUsd: null, costSource: 'unknown' as const });
    const r = diffGroups([noCost({})], [noCost({})]);
    expect(r.metrics.find((m) => m.name === 'costUsd')).toBeUndefined();
    expect(r.notes.join(' ')).toMatch(/Cost unavailable/);
  });
});

describe('minRunsForSignificance', () => {
  it.each([
    [0.05, 4],
    [0.11, 3], // 2/C(6,3) = 0.10 must be strictly below alpha
    [0.01, 5],
  ])('alpha %d -> %d', (alpha, n) => {
    expect(minRunsForSignificance(alpha)).toBe(n);
  });
});

describe('decideVerdict', () => {
  const f = (severity: Finding['severity'], evidence: Finding['evidence'], direction: Finding['direction'] = 'worse'): Finding => ({
    id: 'x', kind: 'metric', severity, evidence, direction, title: '', detail: '',
  });
  it.each([
    [[], 'no-change'],
    [[f('soft', 'weak')], 'possible-drift'],
    [[f('soft', 'strong')], 'drift'],
    [[f('hard', 'weak')], 'likely-regression'],
    [[f('hard', 'strong'), f('soft', 'strong')], 'regression'],
    [[f('hard', 'strong', 'better')], 'no-change'],
  ] as Array<[Finding[], Verdict]>)('%j -> %s', (findings, v) => {
    expect(decideVerdict(findings)).toBe(v);
  });
});

describe('exitCodeFor', () => {
  it.each([
    ['regression', 'regression', 1],
    ['likely-regression', 'regression', 1],
    ['drift', 'regression', 0],
    ['drift', 'drift', 1],
    ['possible-drift', 'drift', 1],
    ['no-change', 'drift', 0],
  ] as const)('%s with failOn=%s -> %d', (v, failOn, code) => {
    expect(exitCodeFor(v, failOn)).toBe(code);
  });
});
