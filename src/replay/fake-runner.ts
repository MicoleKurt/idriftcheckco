import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { z } from 'zod';
import { mulberry32 } from '../diff/stats.js';
import { buildTrace } from '../trace/build.js';
import { categorize } from '../trace/classify.js';
import type { Step, Trace } from '../trace/schema.js';
import type { AgentRunner, RunRequest } from './runner.js';

const ActionSchema = z.object({
  tool: z.string(),
  target: z.string(),
  /** For Write: file contents. For Edit: a line appended to the file. */
  content: z.string().optional(),
  ok: z.boolean().optional(),
});

const BehaviorSchema = z.object({
  actions: z.array(ActionSchema),
  costUsd: z.number().nonnegative().default(0.1),
  durationMs: z.number().nonnegative().default(10_000),
  tokens: z.number().nonnegative().default(10_000),
  status: z.enum(['completed', 'error', 'interrupted', 'unknown']).default('completed'),
  /** Relative run-to-run noise applied to cost, duration and tokens (e.g. 0.1 = ±10%). */
  jitter: z.number().min(0).max(1).default(0.1),
  model: z.string().optional(),
});

/**
 * A scenario maps arm names to one or more behaviours. With several behaviours the
 * runner cycles through them across runs, modelling an agent that sometimes does
 * something different (e.g. skips the tests in 2 of 4 runs).
 */
export const ScenarioSchema = z.record(z.string(), z.union([BehaviorSchema, z.array(BehaviorSchema).min(1)]));
export type Scenario = z.infer<typeof ScenarioSchema>;
export type Behavior = z.infer<typeof BehaviorSchema>;

export function parseScenario(raw: unknown, origin = 'scenario'): Scenario {
  const r = ScenarioSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`Invalid ${origin}: ${i?.path.join('.') || '(root)'}: ${i?.message}. Each arm needs an "actions" list.`);
  }
  return r.data;
}

/**
 * Deterministic stand-in for an agent. It really edits files in the worktree, so the
 * orchestrator's git-diff ground truth and `check` command behave exactly as they
 * would with a real agent. Used by the end-to-end test and `idriftcheckco demo`.
 */
export class FakeRunner implements AgentRunner {
  readonly id = 'fake';
  readonly paid = false;
  private counters = new Map<string, number>();
  private readonly rand: () => number;

  constructor(
    private readonly scenario: Scenario,
    seed = 1,
  ) {
    this.rand = mulberry32(seed);
  }

  private pick(armName: string): Behavior {
    const entry = this.scenario[armName];
    if (!entry) {
      throw new Error(`Fake scenario has no behaviour for "${armName}". Defined: ${Object.keys(this.scenario).join(', ')}.`);
    }
    const list = Array.isArray(entry) ? entry : [entry];
    const n = this.counters.get(armName) ?? 0;
    this.counters.set(armName, n + 1);
    return list[n % list.length]!;
  }

  async run(req: RunRequest): Promise<Trace> {
    const arm = req.variant.name;
    const b = this.pick(arm);
    const jig = (x: number) => x * (1 + (this.rand() * 2 - 1) * b.jitter);
    const steps: Step[] = [];

    for (const [i, a] of b.actions.entries()) {
      const category = categorize(a.tool);
      const ok = a.ok ?? true;
      if (ok && (a.tool === 'Write' || a.tool === 'Edit')) {
        const abs = resolve(req.cwd, a.target);
        if (!abs.startsWith(req.cwd + sep)) throw new Error(`Fake action escapes the worktree: ${a.target}`);
        await mkdir(dirname(abs), { recursive: true });
        if (a.tool === 'Write') await writeFile(abs, a.content ?? '', 'utf8');
        else {
          const before = await readFile(abs, 'utf8').catch(() => '');
          await appendFile(abs, (before.endsWith('\n') || before === '' ? '' : '\n') + (a.content ?? `// edited by ${arm}`) + '\n', 'utf8');
        }
      }
      steps.push({
        index: i,
        kind: 'tool',
        tool: {
          id: `fake-${i}`,
          name: a.tool,
          category,
          target: a.target,
          args: category === 'exec' ? { command: a.target } : { file_path: a.target },
          ok,
          resultPreview: ok ? 'ok' : 'failed',
        },
      });
    }

    const durationMs = Math.round(jig(b.durationMs));
    const start = new Date('2026-01-01T00:00:00.000Z');
    return buildTrace({
      source: { kind: 'fake', adapter: 'fake@1' },
      variant: req.variant,
      task: req.task,
      humanTurns: 1,
      model: req.variant.model ?? b.model ?? 'fake-model',
      startedAt: start.toISOString(),
      endedAt: new Date(start.getTime() + durationMs).toISOString(),
      steps,
      usage: { inputTokens: Math.round(jig(b.tokens)), outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      reportedCostUsd: Math.round(jig(b.costUsd) * 1e4) / 1e4,
      outcome: { status: b.status },
    });
  }
}
