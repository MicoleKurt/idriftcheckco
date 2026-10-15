import { redactString } from '../redact/redact.js';
import type { Store } from '../store/store.js';
import type { Trace, Variant } from '../trace/schema.js';
import type { AgentRunner } from './runner.js';
import { createWorktree } from './worktree.js';

export interface ArmPlan {
  name: string;
  variant: Variant;
  runs: number;
}

export interface ReplayOptions {
  repo: string;
  /** Commit-ish the worktree is created from. Default HEAD. */
  ref?: string;
  /** Number already completed per arm, so ids and stored files continue across rounds. */
  indexOffset?: number;
  task: string;
  /** Tools the agent may use without asking (same for every arm). */
  allowedTools?: string[];
  /** Later human prompts to replay in the same agent session. */
  followUps?: string[];
  arms: ArmPlan[];
  runner: AgentRunner;
  /** Shell command run in the worktree after each agent run; exit 0 = pass. */
  check?: string;
  timeoutMs: number;
  /** Stop launching runs once this much has been spent. */
  maxCostUsd?: number;
  /** Directory that overlay source paths in variants are relative to. */
  baseDir: string;
  /** Persist each trace as soon as it finishes so an interrupted replay loses nothing. */
  persist?: (arm: string, index: number, trace: Trace) => Promise<void>;
  onProgress?: (e: { arm: string; index: number; total: number; trace?: Trace; spentUsd: number }) => void;
  signal?: AbortSignal;
}

export interface ReplayResult {
  arms: Record<string, Trace[]>;
  spentUsd: number;
  /** True if the budget stopped the replay before every run completed. */
  truncated: boolean;
  notes: string[];
}

/**
 * Re-run one task under each arm, `runs` times, each in a fresh isolated worktree.
 * Arms run in the order given; runs within an arm are sequential (agents are heavy and
 * parallel runs would perturb timing and rate limits).
 */
export async function runReplay(opts: ReplayOptions): Promise<ReplayResult> {
  const arms: Record<string, Trace[]> = {};
  const notes: string[] = [];
  let spent = 0;
  let truncated = false;
  const total = opts.arms.reduce((s, a) => s + a.runs, 0);
  let done = 0;

  outer: for (const arm of opts.arms) {
    arms[arm.name] = [];
    for (let i = 0; i < arm.runs; i++) {
      if (opts.signal?.aborted) {
        truncated = true;
        notes.push('Replay was cancelled.');
        break outer;
      }
      if (opts.maxCostUsd !== undefined && spent >= opts.maxCostUsd) {
        truncated = true;
        notes.push(`Stopped at $${spent.toFixed(2)}: reached the spending cap of $${opts.maxCostUsd.toFixed(2)}. Raise it with --max-cost.`);
        break outer;
      }
      opts.onProgress?.({ arm: arm.name, index: done, total, spentUsd: spent });
      const wt = await createWorktree(opts.repo, opts.ref);
      try {
        if (arm.variant.files) await wt.overlay(arm.variant.files, opts.baseDir);
        const remaining = opts.maxCostUsd === undefined ? undefined : Math.max(0.01, opts.maxCostUsd - spent);
        let trace = await opts.runner.run({
          task: opts.task,
          cwd: wt.path,
          variant: arm.variant,
          timeoutMs: opts.timeoutMs,
          ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
          ...(opts.followUps ? { followUps: opts.followUps } : {}),
          ...(remaining !== undefined ? { maxBudgetUsd: Math.round(remaining * 100) / 100 } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        // Ground truth beats anything the agent claims: files come from git, not from tool calls.
        const filesChanged = (await wt.changedFiles()).filter((f) => !f.startsWith('.idriftcheckco/'));
        const check = opts.check ? await wt.runCheck(opts.check, opts.timeoutMs) : undefined;
        trace = {
          ...trace,
          id: `${arm.name}-${String(i + 1 + (opts.indexOffset ?? 0)).padStart(2, '0')}-${trace.id}`,
          filesChanged,
          outcome: { ...trace.outcome, ...(check ? { check } : {}) },
        };
        arms[arm.name]!.push(trace);
        spent += trace.costUsd ?? 0;
        if (opts.persist) await opts.persist(arm.name, i + (opts.indexOffset ?? 0), trace);
        done++;
        opts.onProgress?.({ arm: arm.name, index: done, total, trace, spentUsd: spent });
      } finally {
        await wt.cleanup();
      }
    }
  }
  if (opts.runner.paid && opts.arms.some((a) => (arms[a.name]?.length ?? 0) === 0)) {
    notes.push('At least one arm has no completed runs, so no comparison is possible.');
  }
  return { arms, spentUsd: spent, truncated, notes: notes.map(redactString) };
}

/** Convenience: persist replay traces into a Store run directory. */
export function storePersister(store: Store, runId: string) {
  return (arm: string, index: number, trace: Trace) => store.saveRunTrace(runId, arm, index, trace).then(() => undefined);
}
