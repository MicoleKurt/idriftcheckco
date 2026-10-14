import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseClaudeCodeSession } from '../src/adapters/claude-code.js';
import { TraceSchema, toolCalls } from '../src/trace/schema.js';

const fixture = readFileSync(new URL('./fixtures/session-basic.jsonl', import.meta.url), 'utf8');

describe('parseClaudeCodeSession (basic fixture)', () => {
  const trace = parseClaudeCodeSession(fixture);

  it('produces a schema-valid trace', () => {
    expect(TraceSchema.safeParse(trace).success).toBe(true);
  });
  it('extracts task, model, session id, turns', () => {
    expect(trace.task).toMatch(/off-by-one/);
    expect(trace.model).toBe('claude-opus-4-8');
    expect(trace.source.sessionId).toBe('sess-basic');
    expect(trace.source.sourceVersion).toBe('2.1.200');
    expect(trace.humanTurns).toBe(1);
  });
  it('links tool results and flags errors', () => {
    const calls = toolCalls(trace);
    expect(calls.map((c) => c.name)).toEqual(['Read', 'Edit', 'Bash', 'Edit', 'Bash']);
    expect(calls.map((c) => c.ok)).toEqual([true, true, false, true, true]);
  });
  it('makes paths relative to cwd and derives files', () => {
    expect(trace.filesRead).toEqual(['src/paginate.ts']);
    expect(trace.filesChanged).toEqual(['src/paginate.ts', 'test/paginate.test.ts']);
  });
  it('deduplicates usage by API message id', () => {
    // msg_1 appears twice (two content blocks) and must be counted once.
    expect(trace.usage.inputTokens).toBe(100 + 200 + 300 + 400 + 500 + 600);
    expect(trace.usage.outputTokens).toBe(45 + 80 + 60 + 70 + 40 + 30);
  });
  it('estimates cost and marks it as estimated', () => {
    expect(trace.costSource).toBe('estimated');
    expect(trace.costUsd).toBeGreaterThan(0);
  });
  it('redacts secrets in tool results', () => {
    const failing = toolCalls(trace).find((c) => !c.ok)!;
    expect(failing.resultPreview).not.toContain('sk-ant-abcdefghijklmnop123456');
  });
  it('marks a run that ended on assistant text as completed, not as successful', () => {
    expect(trace.outcome.status).toBe('completed');
    expect(trace.outcome.finalMessage).toMatch(/tests pass/);
  });
  it('computes duration from timestamps', () => {
    expect(trace.durationMs).toBe(36_000);
  });
  it('ignores unknown entry types without failing', () => {
    expect(trace.notes.join(' ')).not.toMatch(/unparsable/);
  });
});

function line(o: unknown): string {
  return JSON.stringify(o);
}

describe('parseClaudeCodeSession (edge cases)', () => {
  it('skips malformed lines and reports them', () => {
    const t = parseClaudeCodeSession(
      `{not json\n${line({ type: 'user', message: { role: 'user', content: 'hi' } })}`,
    );
    expect(t.notes.join(' ')).toMatch(/Skipped 1 unparsable/);
    expect(t.task).toBe('hi');
  });

  it('drops abandoned branches (rewinds) by following parentUuid from the leaf', () => {
    const jsonl = [
      line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'first prompt' } }),
      line({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: { id: 'm1', model: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf x' } }] },
      }),
      // rewind: a new branch from u1
      line({
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u1',
        message: { id: 'm2', model: 'm', content: [{ type: 'text', text: 'done' }] },
      }),
    ].join('\n');
    const t = parseClaudeCodeSession(jsonl);
    expect(toolCalls(t)).toHaveLength(0);
    expect(t.notes.join(' ')).toMatch(/abandoned branch/);
  });

  it('falls back to file order when most of the chain is unreachable', () => {
    const jsonl = [
      line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'p' } }),
      line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', content: [{ type: 'text', text: 'x' }] } }),
      line({ type: 'assistant', uuid: 'a2', parentUuid: 'missing', message: { id: 'm2', content: [{ type: 'text', text: 'y' }] } }),
    ].join('\n');
    const t = parseClaudeCodeSession(jsonl);
    expect(t.steps.filter((s) => s.kind === 'text')).toHaveLength(2);
  });

  it('ignores sidechain (subagent) entries and says so', () => {
    const jsonl = [
      line({ type: 'user', message: { role: 'user', content: 'p' } }),
      line({
        type: 'assistant',
        isSidechain: true,
        message: { id: 's', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }] },
      }),
    ].join('\n');
    const t = parseClaudeCodeSession(jsonl);
    expect(toolCalls(t)).toHaveLength(0);
    expect(t.notes.join(' ')).toMatch(/subagent/);
  });

  it('does not count harness chatter or interrupts as prompts', () => {
    const jsonl = [
      line({ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
      line({ type: 'user', message: { role: 'user', content: 'real task' } }),
      line({ type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } }),
    ].join('\n');
    const t = parseClaudeCodeSession(jsonl);
    expect(t.task).toBe('real task');
    expect(t.humanTurns).toBe(1);
    expect(t.outcome.status).toBe('interrupted');
  });

  it('prefers the cost reported by a stream-json result line', () => {
    const jsonl = [
      line({ type: 'user', message: { role: 'user', content: 'p' } }),
      line({
        type: 'assistant',
        message: { id: 'm', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 10 } },
      }),
      line({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1234 }),
    ].join('\n');
    const t = parseClaudeCodeSession(jsonl);
    expect(t.costUsd).toBe(0.1234);
    expect(t.costSource).toBe('reported');
    expect(t.outcome.status).toBe('completed');
  });

  it('reports unknown cost for unknown models', () => {
    const jsonl = [
      line({ type: 'user', message: { role: 'user', content: 'p' } }),
      line({
        type: 'assistant',
        message: { id: 'm', model: 'mystery-1', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 10 } },
      }),
    ].join('\n');
    const t = parseClaudeCodeSession(jsonl);
    expect(t.costUsd).toBeNull();
    expect(t.costSource).toBe('unknown');
  });

  it('handles an empty file', () => {
    const t = parseClaudeCodeSession('');
    expect(t.steps).toHaveLength(0);
    expect(t.notes.join(' ')).toMatch(/No human prompt/);
  });
});
