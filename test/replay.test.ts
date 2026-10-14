import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffGroups } from '../src/diff/diff.js';
import { buildArgs, buildEnv } from '../src/replay/claude-runner.js';
import { estimateReplay } from '../src/replay/estimate.js';
import { FakeRunner, parseScenario, type Scenario } from '../src/replay/fake-runner.js';
import { runReplay } from '../src/replay/replay.js';
import { createWorktree, parsePorcelainZ } from '../src/replay/worktree.js';
import { mk } from './helpers.js';
import { DEMO_FILES, makeRepo, type TempRepo } from './repo-helper.js';

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

describe('parsePorcelainZ', () => {
  it.each([
    [' M src/a.ts\0?? new.txt\0', ['new.txt', 'src/a.ts']],
    ['R  new.ts\0old.ts\0 M b.ts\0', ['b.ts', 'new.ts']],
    ['', []],
    ['?? dir\\file.txt\0', ['dir/file.txt']],
  ])('%j', (input, expected) => {
    expect(parsePorcelainZ(input)).toEqual(expected);
  });
});

describe('buildEnv (secrets are withheld by default)', () => {
  const source = {
    PATH: '/bin', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 's', MY_VAR: 'v', DATABASE_URL: 'postgres://u:p@h/db',
  };
  it('passes only what the agent needs', () => {
    const env = buildEnv(source);
    expect(env.PATH).toBe('/bin');
    expect(env.ANTHROPIC_API_KEY).toBe('k');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });
  it('lets the user opt extra names in', () => {
    expect(buildEnv(source, ['MY_VAR']).MY_VAR).toBe('v');
  });
});

describe('buildArgs', () => {
  const base = { task: 't', cwd: '/x', timeoutMs: 1000 };
  it('maps variants onto CLI flags', () => {
    const args = buildArgs({ ...base, variant: { name: 'v', model: 'claude-opus-5-5', mcpConfig: 'mcp.json' }, maxBudgetUsd: 1.5 }, { permissionMode: 'acceptEdits' });
    expect(args).toContain('--model');
    expect(args).toContain('claude-opus-5-5');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--max-budget-usd');
    expect(args).toContain('--no-session-persistence');
    expect(args.slice(0, 1)).toEqual(['-p']);
  });
  it.each(['a; rm -rf /', 'x && y', '$(whoami)', 'a|b', '%PATH%', 'a"b', '`id`'])('refuses shell-active argument %s', (bad) => {
    expect(() => buildArgs({ ...base, variant: { name: 'v', extraArgs: [bad] } }, { permissionMode: 'acceptEdits' })).toThrow(/shell-special/);
  });
});

describe('estimateReplay', () => {
  it('prices the source usage at each arm model and shows a band', () => {
    const source = { ...mk({ model: 'claude-opus-4-8' }), usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    const e = estimateReplay(source, [
      { name: 'control', variant: { name: 'control' }, runs: 3 },
      { name: 'new', variant: { name: 'new', model: 'claude-opus-5-5' }, runs: 3 },
    ]);
    expect(e.arms[0]!.costUsd).toBeCloseTo(15, 6); // 3 * $5
    expect(e.arms[1]!.costUsd).toBeCloseTo(12, 6); // 3 * $4
    expect(e.totalUsd).toBeCloseTo(27, 6);
    expect(e.lowUsd).toBeCloseTo(13.5, 6);
    expect(e.highUsd).toBeCloseTo(54, 6);
  });
  it('excludes unknown models and says so', () => {
    const e = estimateReplay(mk({ model: 'claude-opus-4-8' }), [{ name: 'x', variant: { name: 'x', model: 'mystery' }, runs: 2 }]);
    expect(e.arms[0]!.costUsd).toBeNull();
    expect(e.caveats.join(' ')).toMatch(/No price known for "mystery"/);
    expect(e.totalUsd).toBeNull();
  });
});

describe('worktree', () => {
  it('isolates the run: the user checkout is untouched and the worktree is removed', async () => {
    repo = makeRepo(DEMO_FILES);
    const wt = await createWorktree(repo.dir);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(wt.path, 'src/validate.js'), 'changed\n');
    writeFileSync(join(wt.path, 'brand-new.txt'), 'x\n');
    expect(await wt.changedFiles()).toEqual(['brand-new.txt', 'src/validate.js']);
    expect(readFileSync(join(repo.dir, 'src/validate.js'), 'utf8')).toBe(DEMO_FILES['src/validate.js']);
    expect(existsSync(join(repo.dir, 'brand-new.txt'))).toBe(false);
    await wt.cleanup();
    expect(existsSync(wt.path)).toBe(false);
    expect(repo.git('worktree', 'list').trim().split('\n')).toHaveLength(1);
    expect(repo.git('status', '--porcelain').trim()).toBe('');
  });

  it('runs a check command and reports its exit code', async () => {
    repo = makeRepo(DEMO_FILES);
    const wt = await createWorktree(repo.dir);
    try {
      expect((await wt.runCheck('node check.mjs', 20_000)).exitCode).toBe(1);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(wt.path, 'src/validate.js'), 'x.trim()\n');
      expect((await wt.runCheck('node check.mjs', 20_000)).exitCode).toBe(0);
    } finally {
      await wt.cleanup();
    }
  });

  it('kills a check command that exceeds its timeout (whole process tree)', async () => {
    repo = makeRepo(DEMO_FILES);
    const wt = await createWorktree(repo.dir);
    try {
      const started = Date.now();
      const res = await wt.runCheck('node -e "setInterval(() => {}, 1000)"', 800);
      expect(res.exitCode).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await wt.cleanup();
    }
  }, 30_000);

  it('refuses overlays that escape the worktree', async () => {
    repo = makeRepo(DEMO_FILES);
    const wt = await createWorktree(repo.dir);
    try {
      await expect(wt.overlay({ '../../evil.txt': 'README.md' }, repo.dir)).rejects.toThrow(/escapes the worktree/);
    } finally {
      await wt.cleanup();
    }
  });

  it('gives a fix-it error outside a git repository', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    await expect(createWorktree(mkdtempSync(join(tmpdir(), 'idc-nogit-')))).rejects.toThrow(/not inside a git repository/);
  });
});

const SCENARIO: Scenario = parseScenario({
  control: {
    actions: [
      { tool: 'Read', target: 'src/validate.js' },
      { tool: 'Edit', target: 'src/validate.js', content: 'export const trimmed = (s) => s.trim();' },
      { tool: 'Bash', target: 'node check.mjs' },
    ],
    costUsd: 0.2, durationMs: 30_000, tokens: 20_000,
  },
  'new-model': {
    actions: [
      { tool: 'Read', target: 'README.md' },
      { tool: 'Edit', target: 'README.md', content: 'docs only' },
    ],
    costUsd: 0.45, durationMs: 60_000, tokens: 45_000,
  },
});

describe('end-to-end with a fake agent (no API key)', () => {
  it('replays two arms in isolated worktrees and detects the regression', async () => {
    repo = makeRepo(DEMO_FILES);
    const result = await runReplay({
      repo: repo.dir,
      task: 'make validate trim its input',
      arms: [
        { name: 'control', variant: { name: 'control' }, runs: 4 },
        { name: 'new-model', variant: { name: 'new-model', model: 'fake-2' }, runs: 4 },
      ],
      runner: new FakeRunner(SCENARIO, 7),
      check: 'node check.mjs',
      timeoutMs: 30_000,
      baseDir: repo.dir,
    });

    expect(result.truncated).toBe(false);
    expect(result.arms['control']).toHaveLength(4);
    // ground truth from git, not from the agent's own claims
    expect(result.arms['control']![0]!.filesChanged).toEqual(['src/validate.js']);
    expect(result.arms['new-model']![0]!.filesChanged).toEqual(['README.md']);
    // the check command ran in each worktree
    expect(result.arms['control']!.every((t) => t.outcome.check?.exitCode === 0)).toBe(true);
    expect(result.arms['new-model']!.every((t) => t.outcome.check?.exitCode === 1)).toBe(true);

    const report = diffGroups(result.arms['control']!, result.arms['new-model']!);
    expect(report.verdict).toBe('regression');
    const ids = report.findings.map((f) => f.id);
    expect(ids).toContain('file-missing:src/validate.js');
    expect(ids).toContain('file-unexpected:README.md');
    expect(ids).toContain('check');
    expect(ids).toContain('metric:costUsd');

    // the user's repo is pristine and every worktree is gone
    expect(repo.git('status', '--porcelain').trim()).toBe('');
    expect(repo.git('worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('is reproducible for a fixed seed', async () => {
    repo = makeRepo(DEMO_FILES);
    const run = async () =>
      (await runReplay({
        repo: repo!.dir, task: 't', baseDir: repo!.dir, timeoutMs: 30_000,
        arms: [{ name: 'control', variant: { name: 'control' }, runs: 2 }],
        runner: new FakeRunner(SCENARIO, 3),
      })).arms['control']!.map((t) => t.costUsd);
    expect(await run()).toEqual(await run());
  });

  it('stops at the spending cap and says so', async () => {
    repo = makeRepo(DEMO_FILES);
    const result = await runReplay({
      repo: repo.dir, task: 't', baseDir: repo.dir, timeoutMs: 30_000, maxCostUsd: 0.25,
      arms: [{ name: 'control', variant: { name: 'control' }, runs: 5 }],
      runner: new FakeRunner(SCENARIO, 1),
    });
    expect(result.truncated).toBe(true);
    expect(result.arms['control']!.length).toBeLessThan(5);
    expect(result.notes.join(' ')).toMatch(/spending cap/);
  });

  it('persists each trace as it completes', async () => {
    repo = makeRepo(DEMO_FILES);
    const seen: string[] = [];
    await runReplay({
      repo: repo.dir, task: 't', baseDir: repo.dir, timeoutMs: 30_000,
      arms: [{ name: 'control', variant: { name: 'control' }, runs: 2 }],
      runner: new FakeRunner(SCENARIO, 1),
      persist: async (arm, i) => void seen.push(`${arm}:${i}`),
    });
    expect(seen).toEqual(['control:0', 'control:1']);
  });

  it('cleans up the worktree even when the runner throws', async () => {
    repo = makeRepo(DEMO_FILES);
    const boom = { id: 'boom', paid: false, run: () => Promise.reject(new Error('agent crashed')) };
    await expect(
      runReplay({ repo: repo.dir, task: 't', baseDir: repo.dir, timeoutMs: 1000, arms: [{ name: 'a', variant: { name: 'a' }, runs: 1 }], runner: boom }),
    ).rejects.toThrow(/agent crashed/);
    expect(repo.git('worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('rejects an invalid scenario with a helpful message', () => {
    expect(() => parseScenario({ control: { nope: 1 } })).toThrow(/Invalid scenario/);
  });
});
