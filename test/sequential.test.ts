import { copyFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../src/cli/context.js';
import { main } from '../src/cli/main.js';
import { choose } from '../src/diff/stats.js';
import { decideStop, planLooks } from '../src/diff/sequential.js';
import type { DiffReport, Finding } from '../src/diff/types.js';
import { DEMO_FILES, makeRepo, type TempRepo } from './repo-helper.js';

describe('planLooks', () => {
  it.each([
    [0.05, 8, [5, 7, 8]],
    [0.05, 6, [5, 6]],
    [0.05, 4, [4]],
    [0.1, 8, [4, 6, 8]],
  ])('alpha %d, max %d -> looks %j', (alpha, max, looks) => {
    expect(planLooks(alpha, max).looks).toEqual(looks);
  });

  it.each([
    [0.05, 8], [0.05, 10], [0.05, 12], [0.01, 10], [0.1, 6], [0.05, 5],
  ])('alpha %d, max %d: a valid plan', (alpha, max) => {
    const p = planLooks(alpha, max);
    // ascending, ends at the maximum
    expect([...p.looks].sort((a, b) => a - b)).toEqual(p.looks);
    expect(p.looks[p.looks.length - 1]).toBe(max);
    // alpha is split, never exceeded overall (Bonferroni)
    expect(p.alphaPerLook * p.looks.length).toBeLessThanOrEqual(alpha + 1e-12);
    // the first look can actually reach significance (else it would be wasted money)
    if (p.looks.length > 1) expect(2 / choose(2 * p.looks[0]!, p.looks[0]!)).toBeLessThan(p.alphaPerLook);
  });

  it('falls back to a single look when the maximum is too small', () => {
    expect(planLooks(0.05, 3)).toEqual({ looks: [3], alphaPerLook: 0.05, maxRuns: 3 });
  });
});

describe('decideStop', () => {
  const f = (severity: Finding['severity'], evidence: Finding['evidence'], direction: Finding['direction'] = 'worse'): Finding => ({
    id: 'x', kind: 'metric', severity, evidence, direction, title: '', detail: '',
  });
  const report = (findings: Finding[]) => ({ findings }) as unknown as DiffReport;
  it.each([
    [[f('hard', 'strong')], false, 'confirmed-regression'],
    [[], false, 'no-signal'],
    [[f('soft', 'weak', 'better')], false, 'no-signal'],
    [[f('hard', 'weak')], false, 'continue'],
    [[f('soft', 'strong')], false, 'continue'],
    [[f('hard', 'weak')], true, 'max-runs'],
  ] as const)('%j (last=%s) -> %s', (findings, last, expected) => {
    expect(decideStop(report([...findings]), last)).toBe(expected);
  });
});

describe('--runs auto end to end (scripted agent)', () => {
  let repo: TempRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
    repo = undefined;
  });

  const good = {
    actions: [
      { tool: 'Read', target: 'src/validate.js' },
      { tool: 'Edit', target: 'src/validate.js', content: 'export const t = (s) => s.trim();' },
      { tool: 'Bash', target: 'node check.mjs' },
    ],
    costUsd: 0.2, durationMs: 30_000, tokens: 20_000,
  };
  const bad = { actions: [{ tool: 'Edit', target: 'README.md', content: 'docs' }], costUsd: 0.5, durationMs: 60_000, tokens: 50_000 };

  async function run(scenario: unknown) {
    repo = makeRepo(DEMO_FILES);
    writeFileSync(join(repo.dir, 'scenario.json'), JSON.stringify(scenario));
    const fixture = join(process.cwd(), 'test', 'fixtures', 'session-basic.jsonl');
    const session = join(repo.dir, 'session.jsonl');
    copyFileSync(fixture, session);
    const err: string[] = [];
    const out: string[] = [];
    const ctx: Ctx = { cwd: repo.dir, env: {}, stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), color: false, interactive: false, confirm: async () => false };
    await main(['import', session], ctx);
    const code = await main(
      ['replay', 'session', '--model', 'fake-2', '--runs', 'auto', '--runner', 'fake', '--scenario', 'scenario.json', '--check', 'node check.mjs', '--yes', '--ref', 'HEAD'],
      ctx,
    );
    const runsDir = join(repo.dir, '.idriftcheckco', 'runs');
    const runId = readdirSync(runsDir)[0]!;
    const count = (arm: string) => readdirSync(join(runsDir, runId, arm)).length;
    return { code, out: out.join('\n'), err: err.join('\n'), count };
  }

  it('stops at the first look when the regression is obvious (10 runs instead of 16)', async () => {
    const r = await run({ control: good, 'fake-2': bad });
    expect(r.code).toBe(0);
    expect(r.count('control')).toBe(5);
    expect(r.count('fake-2')).toBe(5);
    expect(r.out).toContain('REGRESSION');
    expect(r.out).toContain('stopped at 5 of 8 per side, regression confirmed');
    expect(r.err).toContain('look at 5 runs per side: confirmed-regression');
  }, 120_000);

  it('stops at the first look when nothing differs', async () => {
    const r = await run({ control: good, 'fake-2': good });
    expect(r.count('fake-2')).toBe(5);
    expect(r.out).toContain('NO CHANGE');
    expect(r.out).toContain('no sign of a difference');
  }, 120_000);

  it('keeps going to the maximum when the evidence stays mixed', async () => {
    const r = await run({ control: good, 'fake-2': [good, bad] });
    expect(r.count('control')).toBe(8);
    expect(r.count('fake-2')).toBe(8);
    expect(r.out).toContain('used all 8 runs per side');
  }, 180_000);

  it('shows the adaptive plan and both cost bounds in a dry run', async () => {
    repo = makeRepo(DEMO_FILES);
    const session = join(repo.dir, 'session.jsonl');
    copyFileSync(join(process.cwd(), 'test', 'fixtures', 'session-basic.jsonl'), session);
    const err: string[] = [];
    const ctx: Ctx = { cwd: repo.dir, env: {}, stdout: () => undefined, stderr: (s) => void err.push(s), color: false, interactive: false, confirm: async () => false };
    writeFileSync(join(repo.dir, 'idriftcheckco.config.json'), JSON.stringify({ claudeBin: process.execPath, claudeArgs: [join(process.cwd(), 'test', 'fixtures', 'fake-agent-cli.mjs'), 'ok'] }));
    await main(['import', session], ctx);
    expect(await main(['replay', 'session', '--model', 'claude-opus-5-5', '--runs', 'auto', '--dry-run'], ctx)).toBe(0);
    const text = err.join('\n');
    expect(text).toContain('runs:  adaptive, 5 to 8 per side (looks at 5, 7, 8, alpha 0.0167 each)');
    expect(text).toMatch(/best case \$[0-9.]+, worst case below/);
  });
});
