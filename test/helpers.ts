import { buildTrace } from '../src/trace/build.js';
import { categorize } from '../src/trace/classify.js';
import type { Step, Trace } from '../src/trace/schema.js';

/** [toolName, target, ok?] */
export type Call = [string, string, boolean?];

export interface MkOptions {
  id?: string;
  model?: string;
  calls?: Call[];
  status?: Trace['outcome']['status'];
  costUsd?: number;
  durationMs?: number;
  tokens?: number;
  check?: { command: string; exitCode: number };
  humanTurns?: number;
  variant?: string;
}

let counter = 0;

/** Build a Trace for tests without touching any transcript format. */
export function mk(o: MkOptions = {}): Trace {
  const steps: Step[] = (o.calls ?? []).map(([name, target, ok = true], i) => {
    const category = categorize(name);
    const args: Record<string, unknown> =
      category === 'exec' ? { command: target } : category === 'search' ? { pattern: target } : { file_path: target };
    return {
      index: i,
      kind: 'tool' as const,
      tool: { id: `t${i}`, name, category, target, args, ok, resultPreview: '' },
    };
  });
  const start = '2026-01-01T00:00:00.000Z';
  const end = new Date(Date.parse(start) + (o.durationMs ?? 10_000)).toISOString();
  const trace = buildTrace({
    id: o.id ?? `t${++counter}`,
    source: { kind: 'fake', adapter: 'test' },
    ...(o.variant ? { variant: { name: o.variant } } : {}),
    task: 'do the thing',
    humanTurns: o.humanTurns ?? 1,
    model: o.model ?? 'claude-opus-4-8',
    startedAt: start,
    endedAt: end,
    steps,
    usage: { inputTokens: o.tokens ?? 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    reportedCostUsd: o.costUsd ?? 0.1,
    outcome: { status: o.status ?? 'completed', ...(o.check ? { check: o.check } : {}) },
  });
  return trace;
}

/** n copies of mk(o), each with a distinct id; `vary` can tweak per-index options. */
export function many(n: number, o: MkOptions = {}, vary: (i: number) => Partial<MkOptions> = () => ({})): Trace[] {
  return Array.from({ length: n }, (_, i) => mk({ ...o, ...vary(i) }));
}

export const FIX_AND_TEST: Call[] = [
  ['Read', 'src/a.ts'],
  ['Edit', 'src/a.ts'],
  ['Bash', 'pnpm test'],
];
