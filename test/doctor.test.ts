import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { preflightOrThrow, renderChecks } from '../src/cli/checks.js';
import { runDoctor } from '../src/cli/commands/doctor.js';
import type { Ctx } from '../src/cli/context.js';
import { ClaudeCodeRunner } from '../src/replay/claude-runner.js';
import type { AgentRunner, Check } from '../src/replay/runner.js';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-agent-cli.mjs', import.meta.url));
const runner = (mode: string, env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? process.env.Path }) =>
  new ClaudeCodeRunner({ bin: process.execPath, binArgs: [FAKE_CLI, mode], env });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idc-doctor-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(over: Partial<Ctx> = {}) {
  const err: string[] = [];
  const c: Ctx = {
    cwd: dir, env: { CLAUDE_CONFIG_DIR: join(dir, 'no-sessions') }, stdout: () => undefined, stderr: (s) => void err.push(s),
    color: false, interactive: false, confirm: async () => false, ...over,
  };
  return { c, err: () => err.join('\n') };
}

const byName = (checks: Check[], name: string) => checks.find((c) => c.name === name);

describe('ClaudeCodeRunner.preflight (free: makes no model call)', () => {
  it('passes when the CLI starts and is logged in', async () => {
    const checks = await runner('ok').preflight(dir);
    expect(byName(checks, 'agent CLI')).toMatchObject({ status: 'ok', detail: '9.9.9 (stand-in agent)' });
    expect(byName(checks, 'agent auth')).toMatchObject({ status: 'ok', detail: 'logged in' });
  });
  it('fails with a fix when the CLI is not logged in', async () => {
    const auth = byName(await runner('logged-out').preflight(dir), 'agent auth')!;
    expect(auth.status).toBe('fail');
    expect(auth.fix).toMatch(/auth login|ANTHROPIC_API_KEY/);
  });
  it('trusts an API key in the environment without asking the CLI', async () => {
    const auth = byName(await runner('logged-out', { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'k' }).preflight(dir), 'agent auth')!;
    expect(auth).toMatchObject({ status: 'ok', detail: 'credentials from ANTHROPIC_API_KEY' });
  });
  it('warns, but does not block, when the login state cannot be read', async () => {
    expect(byName(await runner('auth-garbage').preflight(dir), 'agent auth')!.status).toBe('warn');
  });
  it('fails when the CLI cannot start at all', async () => {
    const checks = await new ClaudeCodeRunner({ bin: 'definitely-not-an-installed-agent-cli' }).preflight(dir);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: 'agent CLI', status: 'fail' });
  });
});

describe('preflightOrThrow', () => {
  const stub = (checks: Check[], paid = true): AgentRunner => ({ id: 's', paid, run: () => Promise.reject(new Error('unused')), preflight: async () => checks });
  const fail: Check = { name: 'agent auth', status: 'fail', detail: 'the agent CLI is not logged in', fix: 'log in' };

  it('stops a paid run before anything is spent, listing the fix', async () => {
    const { c, err } = ctx();
    await expect(preflightOrThrow(c, stub([fail]), false)).rejects.toThrow(/Not starting: the agent CLI is not logged in\. Nothing was spent/);
    expect(err()).toContain('log in');
  });
  it('only warns in a dry run', async () => {
    const { c, err } = ctx();
    await expect(preflightOrThrow(c, stub([fail]), true)).resolves.toBeUndefined();
    expect(err()).toContain('a real run would fail');
  });
  it('lets warnings through', async () => {
    await expect(preflightOrThrow(ctx().c, stub([{ name: 'x', status: 'warn', detail: 'hmm' }]), false)).resolves.toBeUndefined();
  });
  it('skips free runners entirely', async () => {
    await expect(preflightOrThrow(ctx().c, stub([fail], false), false)).resolves.toBeUndefined();
  });
});

describe('runDoctor', () => {
  it('reports node, git, config, sessions and the agent, with fixes', async () => {
    const checks = await runDoctor(ctx().c, runner('logged-out'));
    const names = checks.map((c) => c.name);
    for (const n of ['node', 'git', 'git repository', 'config', 'sessions', 'agent CLI', 'agent auth']) expect(names).toContain(n);
    expect(byName(checks, 'node')!.status).toBe('ok');
    expect(byName(checks, 'git repository')!.status).toBe('warn'); // temp dir is not a repo
    expect(byName(checks, 'sessions')!.status).toBe('warn');
    expect(byName(checks, 'agent auth')!.status).toBe('fail');
    const text = renderChecks(checks, false);
    expect(text).toContain('✗ agent auth');
    expect(text).toContain('→ Run `claude auth login`');
  });
});
