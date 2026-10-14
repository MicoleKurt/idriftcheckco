import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseClaudeCodeSession } from '../src/adapters/claude-code.js';
import { encodeProjectDir } from '../src/adapters/discover.js';
import { buildArgs, ClaudeCodeRunner, mergeTurns } from '../src/replay/claude-runner.js';
import { estimateReplay } from '../src/replay/estimate.js';
import { resolveAllowedTools, toolsFromTrace } from '../src/replay/permissions.js';
import { resolveAutoRef } from '../src/replay/worktree.js';
import { mk } from './helpers.js';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-agent-cli.mjs', import.meta.url));
const temps: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const line = (o: unknown) => JSON.stringify(o);

describe('adapter: follow-up prompts and branch', () => {
  const jsonl = [
    line({ type: 'user', gitBranch: 'HEAD', message: { role: 'user', content: 'first task' } }),
    line({ type: 'assistant', gitBranch: 'feature/login', message: { id: 'a', content: [{ type: 'text', text: 'ok' }] } }),
    line({ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
    line({ type: 'user', message: { role: 'user', content: 'now add tests, token=sk-ant-abcdefghijklmnop' } }),
    line({ type: 'user', message: { role: 'user', content: 'and update the README' } }),
  ].join('\n');
  const t = parseClaudeCodeSession(jsonl);

  it('keeps later human prompts in order, without harness chatter, redacted', () => {
    expect(t.task).toBe('first task');
    expect(t.followUps).toHaveLength(2);
    expect(t.followUps[0]).toMatch(/^now add tests/);
    expect(t.followUps[0]).not.toContain('sk-ant-abcdef');
    expect(t.followUps[1]).toBe('and update the README');
    expect(t.humanTurns).toBe(3);
  });
  it('records the branch, ignoring a detached "HEAD"', () => {
    expect(t.gitBranch).toBe('feature/login');
  });
});

describe('resolveAutoRef (replay on the code as it was)', () => {
  /** Repo with commits dated Jan, Mar and May 2026 on main, plus a branch commit in Apr. */
  function datedRepo() {
    const dir = tmp('idc-ref-');
    const git = (args: string[], date?: string) =>
      execFileSync('git', args, {
        cwd: dir, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
      }).trim();
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 't']);
    git(['config', 'user.email', 't@e.com']);
    git(['config', 'commit.gpgsign', 'false']);
    const commit = (msg: string, date: string) => {
      writeFileSync(join(dir, `${msg}.txt`), msg);
      git(['add', '-A']);
      git(['commit', '-q', '-m', msg], date);
      return git(['rev-parse', 'HEAD']);
    };
    const jan = commit('jan', '2026-01-10T12:00:00Z');
    const mar = commit('mar', '2026-03-10T12:00:00Z');
    git(['checkout', '-q', '-b', 'feature']);
    const apr = commit('apr', '2026-04-10T12:00:00Z');
    git(['checkout', '-q', 'main']);
    const may = commit('may', '2026-05-10T12:00:00Z');
    return { dir, jan, mar, apr, may };
  }

  it('picks the last commit before the session on the main history', async () => {
    const r = datedRepo();
    expect((await resolveAutoRef(r.dir, '2026-02-01T00:00:00Z')).ref).toBe(r.jan);
    expect((await resolveAutoRef(r.dir, '2026-04-20T00:00:00Z')).ref).toBe(r.mar);
    const latest = await resolveAutoRef(r.dir, '2026-06-01T00:00:00Z');
    expect(latest.ref).toBe(r.may);
    expect(latest.note).toContain('HEAD');
  });
  it('follows the session branch when it exists locally', async () => {
    const r = datedRepo();
    const c = await resolveAutoRef(r.dir, '2026-04-20T00:00:00Z', 'feature');
    expect(c.ref).toBe(r.apr);
    expect(c.note).toContain('on feature');
    expect(c.note).toContain('Uncommitted changes');
  });
  it('falls back to HEAD history when the branch is gone, and says so', async () => {
    const r = datedRepo();
    const c = await resolveAutoRef(r.dir, '2026-04-20T00:00:00Z', 'deleted-branch');
    expect(c.ref).toBe(r.mar);
    expect(c.note).toContain('not found locally');
  });
  it('uses HEAD when no commit predates the session, or the time is unknown', async () => {
    const r = datedRepo();
    expect(await resolveAutoRef(r.dir, '2025-01-01T00:00:00Z')).toMatchObject({ ref: 'HEAD' });
    expect((await resolveAutoRef(r.dir, undefined)).note).toMatch(/unknown/);
    expect((await resolveAutoRef(r.dir, 'not a date')).ref).toBe('HEAD');
  });
  it('never passes a branch name that looks like an option to git', async () => {
    const r = datedRepo();
    const c = await resolveAutoRef(r.dir, '2026-04-20T00:00:00Z', '--output=/tmp/pwned');
    expect(c.ref).toBe(r.mar);
    expect(existsSync('/tmp/pwned')).toBe(false);
  });
});

describe('permissions: replay with the tools the session used', () => {
  const session = mk({ calls: [['Read', 'a.ts'], ['Edit', 'a.ts'], ['Bash', 'pnpm test'], ['Bash', 'git status'], ['mcp__github__get_issue', 'x'], ['Read', 'b.ts']] });

  it('collects each tool once, sorted, MCP tools included', () => {
    expect(toolsFromTrace(session)).toEqual(['Bash', 'Edit', 'Read', 'mcp__github__get_issue']);
  });
  it.each([
    ['session', ['Bash', 'Edit', 'Read', 'mcp__github__get_issue']],
    ['none', undefined],
    [['Read', 'Grep', 'bad name;rm'], ['Read', 'Grep']],
  ] as const)('policy %j', (policy, expected) => {
    expect(resolveAllowedTools(policy as never, session)).toEqual(expected);
  });
  it('a session with no tool calls passes no flag', () => {
    expect(resolveAllowedTools('session', mk())).toBeUndefined();
  });
  it('is passed to the agent CLI as one comma-separated argument', () => {
    const args = buildArgs({ task: 't', cwd: '.', timeoutMs: 1, variant: { name: 'v' }, allowedTools: ['Bash', 'Edit'] }, { permissionMode: 'acceptEdits' });
    expect(args).toContain('--allowedTools');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Bash,Edit');
  });
});

describe('multi-turn replay (--turns all)', () => {
  it('first turn starts a persisted session, later turns resume it', () => {
    const req = { task: 't', cwd: '.', timeoutMs: 1, variant: { name: 'v' } };
    const first = buildArgs(req, { permissionMode: 'acceptEdits', session: { id: 'abc', resume: false } });
    const later = buildArgs(req, { permissionMode: 'acceptEdits', session: { id: 'abc', resume: true } });
    expect(first).toEqual(expect.arrayContaining(['--session-id', 'abc']));
    expect(later).toEqual(expect.arrayContaining(['--resume', 'abc']));
    expect(first).not.toContain('--no-session-persistence');
    expect(buildArgs(req, { permissionMode: 'acceptEdits' })).toContain('--no-session-persistence');
  });

  function runner(mode: string, configDir: string) {
    return new ClaudeCodeRunner({ bin: process.execPath, binArgs: [FAKE_CLI, mode], env: { PATH: process.env.PATH ?? process.env.Path, CLAUDE_CONFIG_DIR: configDir } });
  }

  it('replays every turn in one session, merges them, and deletes the persisted transcript', async () => {
    const cwd = tmp('idc-mt-cwd-');
    const configDir = tmp('idc-mt-cfg-');
    const t = await runner('ok', configDir).run({ task: 'first', followUps: ['second turn', 'third turn here'], cwd, timeoutMs: 20_000, variant: { name: 'v' } });
    expect(t.humanTurns).toBe(3);
    expect(t.followUps).toEqual(['second turn', 'third turn here']);
    const texts = t.steps.filter((s) => s.kind === 'text').map((s) => s.text);
    expect(texts.filter((x) => x?.startsWith('got'))).toHaveLength(3);
    expect(texts.some((x) => x?.includes('resumed'))).toBe(true);
    expect(t.costUsd).toBeCloseTo(0.0369, 6);
    expect(t.costSource).toBe('reported');
    expect(t.notes).toContain('Replayed 3 of 3 human turns in one agent session.');
    const dir = join(configDir, 'projects', encodeProjectDir(cwd));
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it('stops the conversation at the first failed turn', async () => {
    const cwd = tmp('idc-mt-cwd-');
    const configDir = tmp('idc-mt-cfg-');
    const t = await runner('fail-on-resume', configDir).run({ task: 'first', followUps: ['second', 'third'], cwd, timeoutMs: 20_000, variant: { name: 'v' } });
    expect(t.humanTurns).toBe(2);
    expect(t.outcome.status).toBe('error');
    expect(t.notes.join(' ')).toMatch(/Stopped after turn 2 of 3/);
    expect(t.notes.join(' ')).toMatch(/boom on resume/);
  });

  it('a single-turn run is never persisted', async () => {
    const cwd = tmp('idc-mt-cwd-');
    const configDir = tmp('idc-mt-cfg-');
    mkdirSync(join(configDir, 'projects'), { recursive: true });
    await runner('ok', configDir).run({ task: 'only', cwd, timeoutMs: 20_000, variant: { name: 'v' } });
    expect(readdirSync(join(configDir, 'projects'))).toEqual([]);
  });
});

describe('mergeTurns', () => {
  it('sums usage and cost, concatenates steps, keeps the last outcome', () => {
    const a = mk({ calls: [['Read', 'a.ts']], costUsd: 0.1, durationMs: 1000 });
    const b = mk({ calls: [['Edit', 'a.ts']], costUsd: 0.2, durationMs: 2000, status: 'error' });
    const m = mergeTurns([a, b]);
    expect(m.steps.map((s) => s.index)).toEqual([0, 1]);
    expect(m.costUsd).toBeCloseTo(0.3, 9);
    expect(m.durationMs).toBe(3000);
    expect(m.usage.inputTokens).toBe(a.usage.inputTokens + b.usage.inputTokens);
    expect(m.outcome.status).toBe('error');
    expect(m.filesChanged).toEqual(['a.ts']);
  });
  it('cost is unknown if any turn has unknown cost', () => {
    const m = mergeTurns([mk({ costUsd: 0.1 }), { ...mk(), costUsd: null, costSource: 'unknown' }]);
    expect(m.costUsd).toBeNull();
    expect(m.costSource).toBe('unknown');
  });
});

describe('estimate with all turns', () => {
  it('drops the "only the first task" caveat when every turn is replayed', () => {
    const source = { ...mk(), humanTurns: 3 };
    const arms = [{ name: 'c', variant: { name: 'c' }, runs: 1 }];
    expect(estimateReplay(source, arms).caveats.join(' ')).toMatch(/only the first task/);
    expect(estimateReplay(source, arms, {}, { allTurns: true }).caveats.join(' ')).not.toMatch(/only the first task/);
  });
});
