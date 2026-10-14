import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseConfig } from './config.js';
import { Store } from './store/store.js';
import { buildTrace } from './trace/build.js';
import { FakeRunner, parseScenario } from './replay/fake-runner.js';
import { executeReplay } from './cli/run.js';
import type { Ctx } from './cli/context.js';
import type { Trace } from './trace/schema.js';

/** A tiny repo with a real bug and a real check, so the demo exercises the real pipeline. */
export const DEMO_REPO: Record<string, string> = {
  'src/slugify.js': "export const slugify = (s) => s.toLowerCase().replace(/ /g, '-');\n",
  'test.mjs':
    "import assert from 'node:assert';\nimport { slugify } from './src/slugify.js';\n" +
    "assert.equal(slugify('  Hello   World  '), 'hello-world');\n",
  'README.md': '# slugify\n',
};

const FIXED = "export const slugify = (s) => s.trim().toLowerCase().replace(/\\s+/g, '-');\n";
const BUGGY = "export const slugify = (s) => s.toLowerCase().replace(/\\s/g, '-');\n";

/**
 * The story: after a model upgrade the agent got more expensive, stopped running the
 * tests, and "fixed" the function in a way that still fails. Scripted, but replayed
 * through the real worktree, git-diff and check machinery.
 */
export const DEMO_SCENARIO = parseScenario({
  control: {
    actions: [
      { tool: 'Read', target: 'src/slugify.js' },
      { tool: 'Read', target: 'test.mjs' },
      { tool: 'Write', target: 'src/slugify.js', content: FIXED },
      { tool: 'Bash', target: 'node test.mjs' },
    ],
    costUsd: 0.21, durationMs: 38_000, tokens: 41_000, jitter: 0.12,
  },
  'opus-5-5': [
    {
      actions: [
        { tool: 'Read', target: 'src/slugify.js' },
        { tool: 'Write', target: 'src/slugify.js', content: BUGGY },
      ],
      costUsd: 0.46, durationMs: 71_000, tokens: 88_000, jitter: 0.12,
    },
    {
      actions: [
        { tool: 'Read', target: 'src/slugify.js' },
        { tool: 'Read', target: 'README.md' },
        { tool: 'Write', target: 'README.md', content: '# slugify\n\nNow handles spaces.\n' },
      ],
      costUsd: 0.52, durationMs: 80_000, tokens: 97_000, jitter: 0.12,
    },
  ],
});

function demoSource(): Trace {
  return buildTrace({
    id: 'demo-session',
    source: { kind: 'fake', adapter: 'demo@1' },
    task: 'Fix slugify so it trims whitespace and collapses repeated spaces, then make sure the tests pass.',
    humanTurns: 1,
    model: 'claude-opus-4-8',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:40.000Z',
    steps: [],
    usage: { inputTokens: 40_000, outputTokens: 1_500, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outcome: { status: 'completed' },
  });
}

export interface DemoResult {
  reportPath: string;
  report: NonNullable<Awaited<ReturnType<typeof executeReplay>>['report']>;
}

/** Run the full replay pipeline offline against a throwaway repo. No API key, no network. */
export async function runDemo(ctx: Ctx, htmlPath: string): Promise<DemoResult> {
  const dir = mkdtempSync(join(tmpdir(), 'idriftcheckco-demo-'));
  try {
    for (const [p, c] of Object.entries(DEMO_REPO)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, windowsHide: true, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'demo');
    git('config', 'user.email', 'demo@example.com');
    git('config', 'commit.gpgsign', 'false');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    const config = parseConfig({ check: 'node test.mjs', runs: 4 });
    const res = await executeReplay({
      ctx: { ...ctx, cwd: dir },
      config,
      store: new Store(dir),
      source: demoSource(),
      candidate: { name: 'opus-5-5', variant: { name: 'opus-5-5', model: 'claude-opus-5-5' }, runs: 4 },
      control: true,
      controlVariant: { name: 'control', model: 'claude-opus-4-8' },
      runner: new FakeRunner(DEMO_SCENARIO, 11),
      dryRun: false,
      yes: true,
      baseDir: dir,
      htmlPath,
    });
    if (!res.report || !res.reportPath) throw new Error('Demo produced no report.');
    return { reportPath: res.reportPath, report: res.report };
  } finally {
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: dir, windowsHide: true, stdio: 'ignore' });
    } catch {
      /* best effort */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
