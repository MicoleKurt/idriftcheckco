import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeProjectDir } from '../src/adapters/discover.js';
import { main } from '../src/cli/main.js';
import type { Ctx } from '../src/cli/context.js';
import { runDemo } from '../src/demo.js';
import { VERSION } from '../src/version.js';
import { DEMO_FILES, makeRepo, type TempRepo } from './repo-helper.js';

const FIXTURE = new URL('./fixtures/session-basic.jsonl', import.meta.url);

function makeCtx(cwd: string, overrides: Partial<Ctx> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: Ctx = {
    cwd, env: {}, stdout: (s) => void out.push(s), stderr: (s) => void err.push(s),
    color: false, interactive: false, confirm: async () => false, ...overrides,
  };
  return { ctx, out: () => out.join('\n'), err: () => err.join('\n') };
}

let tmp: string;
let repo: TempRepo | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'idc-cli-'));
});
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

/** Create a fake agent config dir containing the fixture session for `cwd`. */
function sessionsFor(cwd: string): string {
  const root = join(tmp, 'agent-config');
  const dir = join(root, 'projects', encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  copyFileSync(FIXTURE, join(dir, 'sess-basic-0001.jsonl'));
  return root;
}

describe('cli basics', () => {
  it('prints the version', async () => {
    const c = makeCtx(tmp);
    expect(await main(['--version'], c.ctx)).toBe(0);
    expect(c.out()).toBe(VERSION);
  });
  it('lists commands in help', async () => {
    const c = makeCtx(tmp);
    expect(await main(['help'], c.ctx)).toBe(0);
    for (const cmd of ['demo', 'replay', 'diff', 'report', 'ci', 'import']) expect(c.out()).toContain(cmd);
  });
  it('shows per-command help', async () => {
    const c = makeCtx(tmp);
    expect(await main(['replay', '--help'], c.ctx)).toBe(0);
    expect(c.out()).toContain('--dry-run');
  });
  it('exits 2 with guidance on an unknown command', async () => {
    const c = makeCtx(tmp);
    expect(await main(['frobnicate'], c.ctx)).toBe(2);
    expect(c.err()).toMatch(/Unknown command "frobnicate".*help/);
  });
  it('exits 2 on an unknown flag and points at --help', async () => {
    const c = makeCtx(tmp);
    expect(await main(['scan', '--nope'], c.ctx)).toBe(2);
    expect(c.err()).toMatch(/--help/);
  });
  it('validates numeric flags', async () => {
    const c = makeCtx(tmp);
    expect(await main(['scan', '--limit', 'abc'], c.ctx)).toBe(2);
    expect(c.err()).toMatch(/--limit must be a number/);
  });
});

describe('scan (the zero-config first screen)', () => {
  it('finds sessions for the current folder and suggests next steps', async () => {
    const cwd = join(tmp, 'proj');
    mkdirSync(cwd);
    const c = makeCtx(cwd);
    expect(await main(['--sessions', sessionsFor(cwd)], c.ctx)).toBe(0); // no subcommand == scan
    expect(c.out()).toContain('found 1 usable session');
    expect(c.out()).toContain('BEST SESSIONS TO REPLAY');
    expect(c.out()).toContain('sess-bas');
    expect(c.out()).toContain('replay sess-bas');
    expect(c.out()).toContain('--dry-run');
  });
  it('falls back to all projects when this folder has none', async () => {
    const other = join(tmp, 'other');
    const cwd = join(tmp, 'empty');
    mkdirSync(cwd);
    const root = sessionsFor(other);
    const c = makeCtx(cwd);
    expect(await main(['scan', '--sessions', root], c.ctx)).toBe(0);
    expect(c.out()).toContain('none found for this folder');
    expect(c.out()).toContain('found 1');
  });
  it('is friendly when there is nothing at all', async () => {
    const c = makeCtx(tmp);
    expect(await main(['scan', '--sessions', join(tmp, 'nope')], c.ctx)).toBe(0);
    expect(c.out()).toContain('No sessions to analyze yet');
    expect(c.out()).toContain('demo');
  });
  it('can emit JSON', async () => {
    const cwd = join(tmp, 'proj');
    mkdirSync(cwd);
    const c = makeCtx(cwd);
    await main(['scan', '--json', '--sessions', sessionsFor(cwd)], c.ctx);
    const parsed = JSON.parse(c.out()) as Array<{ sessionId: string; replayability: { score: number } }>;
    expect(parsed[0]!.sessionId).toBe('sess-basic-0001');
    expect(parsed[0]!.replayability.score).toBeGreaterThan(50);
  });
});

describe('import', () => {
  it('saves a redacted trace by session id prefix', async () => {
    const cwd = join(tmp, 'proj');
    mkdirSync(cwd);
    const c = makeCtx(cwd);
    expect(await main(['import', 'sess-bas', '--sessions', sessionsFor(cwd)], c.ctx)).toBe(0);
    const file = join(cwd, '.idriftcheckco', 'traces', 'sess-basic-0001.json');
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('sk-ant-abcdefghijklmnop123456');
    expect(text).not.toContain('C:\\\\Users\\\\dev');
    expect(c.out()).toContain('redacted');
  });
  it('imports the best sessions when given no arguments', async () => {
    const cwd = join(tmp, 'proj');
    mkdirSync(cwd);
    const c = makeCtx(cwd);
    expect(await main(['import', '--sessions', sessionsFor(cwd)], c.ctx)).toBe(0);
    expect(readdirSync(join(cwd, '.idriftcheckco', 'traces'))).toHaveLength(1);
  });
  it('explains an unknown session id', async () => {
    const cwd = join(tmp, 'proj');
    mkdirSync(cwd);
    const c = makeCtx(cwd);
    expect(await main(['import', 'zzzz', '--sessions', sessionsFor(cwd)], c.ctx)).toBe(2);
    expect(c.err()).toMatch(/No session matches "zzzz".*scan/);
  });
  it('imports a .jsonl file by path', async () => {
    const cwd = join(tmp, 'proj');
    mkdirSync(cwd);
    const c = makeCtx(cwd);
    const file = join(tmp, 'x.jsonl');
    copyFileSync(FIXTURE, file);
    expect(await main(['import', file], c.ctx)).toBe(0);
    expect(c.out()).toContain('imported');
  });
});

describe('replay safety rails', () => {
  async function imported(cwd: string) {
    const c = makeCtx(cwd);
    await main(['import', 'sess-bas', '--sessions', sessionsFor(cwd)], c.ctx);
  }

  it('--dry-run prints an estimate and runs nothing', async () => {
    repo = makeRepo(DEMO_FILES);
    await imported(repo.dir);
    const c = makeCtx(repo.dir);
    expect(await main(['replay', 'sess-bas', '--model', 'claude-opus-5-5', '--dry-run'], c.ctx)).toBe(0);
    expect(c.err()).toContain('Replay plan');
    expect(c.err()).toContain('estimated total');
    expect(c.err()).toContain('Dry run');
    expect(existsSync(join(repo.dir, '.idriftcheckco', 'runs'))).toBe(false);
  });

  it('refuses to spend money without confirmation when no terminal is attached', async () => {
    repo = makeRepo(DEMO_FILES);
    await imported(repo.dir);
    const c = makeCtx(repo.dir);
    expect(await main(['replay', 'sess-bas', '--model', 'claude-opus-5-5'], c.ctx)).toBe(2);
    expect(c.err()).toMatch(/--yes/);
    expect(existsSync(join(repo.dir, '.idriftcheckco', 'runs'))).toBe(false);
  });

  it('refuses when the low-end estimate already exceeds --max-cost', async () => {
    repo = makeRepo(DEMO_FILES);
    await imported(repo.dir);
    const c = makeCtx(repo.dir);
    expect(await main(['replay', 'sess-bas', '--model', 'claude-fable-5-1', '--runs', '10', '--max-cost', '0.01', '--yes'], c.ctx)).toBe(2);
    expect(c.err()).toMatch(/exceeds --max-cost/);
  });

  it('requires something to change', async () => {
    repo = makeRepo(DEMO_FILES);
    await imported(repo.dir);
    const c = makeCtx(repo.dir);
    expect(await main(['replay', 'sess-bas', '--dry-run'], c.ctx)).toBe(2);
    expect(c.err()).toMatch(/Nothing to change/);
  });

  it('rejects malformed overlays', async () => {
    repo = makeRepo(DEMO_FILES);
    await imported(repo.dir);
    const c = makeCtx(repo.dir);
    expect(await main(['replay', 'sess-bas', '--overlay', 'nonsense', '--dry-run'], c.ctx)).toBe(2);
    expect(c.err()).toMatch(/DEST=SRC/);
  });

  it('exits 3 (runtime) outside a git repository, with a fix-it message', async () => {
    const cwd = join(tmp, 'plain');
    mkdirSync(cwd);
    await imported(cwd);
    writeFileSync(join(cwd, 'scenario.json'), JSON.stringify({ control: { actions: [] }, x: { actions: [] } }));
    const c = makeCtx(cwd);
    expect(await main(['replay', 'sess-bas', '--model', 'x', '--runner', 'fake', '--scenario', 'scenario.json', '--yes', '--runs', '1'], c.ctx)).toBe(3);
    expect(c.err()).toMatch(/not inside a git repository/);
  });
});

describe('replay -> diff -> report -> ci with a fake agent', () => {
  const regressing = {
    control: {
      actions: [
        { tool: 'Read', target: 'src/validate.js' },
        { tool: 'Edit', target: 'src/validate.js', content: 'export const t = (s) => s.trim();' },
        { tool: 'Bash', target: 'node check.mjs' },
      ],
      costUsd: 0.2, durationMs: 30_000, tokens: 20_000,
    },
    'fake-2': { actions: [{ tool: 'Edit', target: 'README.md', content: 'docs' }], costUsd: 0.5, durationMs: 60_000, tokens: 50_000 },
  };
  const stable = { control: regressing.control, 'fake-2': regressing.control };

  async function setup(scenario: unknown) {
    repo = makeRepo(DEMO_FILES);
    const cwd = repo.dir;
    writeFileSync(join(cwd, 'scenario.json'), JSON.stringify(scenario));
    await main(['import', 'sess-bas', '--sessions', sessionsFor(cwd)], makeCtx(cwd).ctx);
    return cwd;
  }
  const replayArgs = ['replay', 'sess-bas', '--model', 'fake-2', '--runs', '4', '--runner', 'fake', '--scenario', 'scenario.json', '--check', 'node check.mjs', '--yes'];

  it('detects the regression, exits 1 with --fail-on, and writes a self-contained report', async () => {
    const cwd = await setup(regressing);
    const c = makeCtx(cwd);
    expect(await main([...replayArgs, '--fail-on', 'regression'], c.ctx)).toBe(1);
    expect(c.out()).toContain('REGRESSION');
    expect(c.out()).toContain('node check.mjs');
    const reports = readdirSync(join(cwd, '.idriftcheckco', 'reports'));
    expect(reports).toHaveLength(1);
    const html = readFileSync(join(cwd, '.idriftcheckco', 'reports', reports[0]!), 'utf8');
    expect(html).toContain('REGRESSION');
    expect(html).not.toMatch(/<script/i);
    // the user's checkout is untouched
    expect(repo!.git('status', '--porcelain', '--', 'src', 'README.md', 'check.mjs').trim()).toBe('');
  });

  it('exits 0 when nothing changed', async () => {
    const cwd = await setup(stable);
    const c = makeCtx(cwd);
    expect(await main([...replayArgs, '--fail-on', 'regression'], c.ctx)).toBe(0);
    expect(c.out()).toContain('NO CHANGE');
  });

  it('can compare against the original session without control runs', async () => {
    const cwd = await setup(regressing);
    const c = makeCtx(cwd);
    expect(await main([...replayArgs, '--no-control'], c.ctx)).toBe(0);
    expect(c.out()).toContain('original');
    expect(c.out()).toContain('Baseline is the original human session');
  });

  it('diff, report and ci all work on the stored run', async () => {
    const cwd = await setup(regressing);
    await main(replayArgs, makeCtx(cwd).ctx);

    const d = makeCtx(cwd);
    expect(await main(['diff', 'latest', '--fail-on', 'regression'], d.ctx)).toBe(1);
    expect(d.out()).toContain('REGRESSION');

    const d2 = makeCtx(cwd);
    expect(await main(['diff', 'latest:control', 'latest:fake-2', '--format', 'json'], d2.ctx)).toBe(0);
    expect(JSON.parse(d2.out()).verdict).toBe('regression');

    const r = makeCtx(cwd);
    expect(await main(['report', 'latest', '--out', join(tmp, 'r.html')], r.ctx)).toBe(0);
    expect(readFileSync(join(tmp, 'r.html'), 'utf8')).toContain('<!doctype html>');

    const ci = makeCtx(cwd);
    expect(
      await main(['ci', '--run', 'latest', '--json-out', join(tmp, 'ci.json'), '--md-out', join(tmp, 'ci.md'), '--badge-out', join(tmp, 'badge.json')], ci.ctx),
    ).toBe(1);
    expect(JSON.parse(readFileSync(join(tmp, 'ci.json'), 'utf8')).verdict).toBe('regression');
    expect(readFileSync(join(tmp, 'ci.md'), 'utf8')).toContain('<!-- idriftcheckco-report -->');
    expect(JSON.parse(readFileSync(join(tmp, 'badge.json'), 'utf8')).color).toBe('red');
  });

  it('ci in replay mode runs the suite and gates on the result', async () => {
    const cwd = await setup(regressing);
    const c = makeCtx(cwd);
    const code = await main(['ci', '--model', 'fake-2', '--runs', '4', '--runner', 'fake', '--scenario', 'scenario.json', '--check', 'node check.mjs', '--yes', '--format', 'json'], c.ctx);
    expect(code).toBe(1);
    const suite = JSON.parse(c.out()) as { verdict: string; exitCode: number; tasks: unknown[] };
    expect(suite.verdict).toBe('regression');
    expect(suite.tasks).toHaveLength(1);
  });

  it('ci --fail-on drift is stricter than the default', async () => {
    const cwd = await setup({ control: regressing.control, 'fake-2': { ...regressing.control, costUsd: 0.6 } });
    await main(replayArgs, makeCtx(cwd).ctx);
    expect(await main(['ci', '--run', 'latest'], makeCtx(cwd).ctx)).toBe(0);
    expect(await main(['ci', '--run', 'latest', '--fail-on', 'drift'], makeCtx(cwd).ctx)).toBe(1);
  });

  it('diff gives a helpful error for an unknown arm', async () => {
    const cwd = await setup(regressing);
    await main(replayArgs, makeCtx(cwd).ctx);
    const c = makeCtx(cwd);
    expect(await main(['diff', 'latest:nope', 'latest:control'], c.ctx)).toBe(2);
    expect(c.err()).toMatch(/no arm "nope"/);
  });
});

describe('demo', () => {
  it('runs the whole pipeline offline and finds the planted regression', async () => {
    const out = join(tmp, 'demo.html');
    const { report, reportPath } = await runDemo(makeCtx(tmp).ctx, out);
    expect(report.verdict).toBe('regression');
    expect(report.findings.map((f) => f.id)).toContain('check');
    expect(report.findings.map((f) => f.id)).toContain('verification-dropped:exec:node test.mjs');
    expect(existsSync(reportPath)).toBe(true);
  });

  it('is exposed as `idriftcheckco demo`', async () => {
    const c = makeCtx(tmp);
    expect(await main(['demo', '--out', join(tmp, 'd.html')], c.ctx)).toBe(0);
    expect(c.out()).toContain('REGRESSION');
    expect(c.out()).toContain('Full report');
  });
});
