import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTH_HINT, ClaudeCodeRunner } from '../src/replay/claude-runner.js';
import { toolCalls } from '../src/trace/schema.js';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-agent-cli.mjs', import.meta.url));
const runner = (mode: string) => new ClaudeCodeRunner({ bin: process.execPath, binArgs: [FAKE_CLI, mode] });
const req = (task = 'fix the thing') => ({ task, cwd: process.cwd(), variant: { name: 'v', model: 'claude-opus-4-8' }, timeoutMs: 15_000 });

describe('ClaudeCodeRunner with a stand-in agent process', () => {
  it('delivers the task on stdin and parses the stream into a trace', async () => {
    const t = await runner('ok').run(req('x'.repeat(5000)));
    expect(t.source.kind).toBe('replay');
    expect(t.task).toContain('xxxx');
    expect(toolCalls(t).map((c) => c.name)).toEqual(['Bash']);
    expect(t.steps.some((s) => s.text?.includes('got 5000 chars'))).toBe(true); // long task arrived intact via stdin
    expect(t.outcome.status).toBe('completed');
    expect(t.costUsd).toBe(0.0123);
    expect(t.costSource).toBe('reported');
    expect(t.variant?.name).toBe('v');
  });

  it('does not leave the "no human prompt" adapter note on replay traces', async () => {
    expect((await runner('ok').run(req())).notes.join(' ')).not.toMatch(/No human prompt/);
  });

  it('reports an authentication failure clearly and does not blame the model', async () => {
    const t = await runner('auth-fail').run(req());
    expect(t.outcome.status).toBe('error');
    expect(t.notes.join(' ')).toContain('Failed to authenticate');
    expect(t.notes).toContain(AUTH_HINT);
  });

  it('stops a hung agent at the timeout and says so', async () => {
    const t = await runner('hang').run({ ...req(), timeoutMs: 700 });
    expect(t.outcome.status).toBe('interrupted');
    expect(t.notes.join(' ')).toMatch(/Timed out after/);
  }, 20_000);

  it('surfaces a missing agent executable instead of hanging or passing silently', async () => {
    const r = new ClaudeCodeRunner({ bin: 'definitely-not-an-installed-agent-cli' });
    const outcome = await r.run(req()).then(
      (trace) => ({ trace }),
      (error: Error) => ({ error }),
    );
    if ('error' in outcome) {
      // POSIX: spawn fails with ENOENT, which we translate into guidance.
      expect(outcome.error.message).toMatch(/Could not start "definitely-not-an-installed-agent-cli".*claudeBin/);
    } else {
      // Windows: the shell reports "not recognized" and exits non-zero.
      expect(outcome.trace.outcome.status).toBe('error');
      expect(outcome.trace.notes.join(' ')).toMatch(/exited with code/);
    }
  });
});
