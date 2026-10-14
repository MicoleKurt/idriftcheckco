import type { Trace, Variant } from '../trace/schema.js';

export interface RunRequest {
  task: string;
  /** Isolated worktree the agent runs in. Never the user's checkout. */
  cwd: string;
  variant: Variant;
  timeoutMs: number;
  /** Per-run spending cap in USD, if the runner supports one. */
  maxBudgetUsd?: number;
  signal?: AbortSignal;
}

/** Result of one environment check (used by `doctor` and the pre-flight before paid runs). */
export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  /** What to do about it. */
  fix?: string;
}

/**
 * Anything that can attempt a task inside a directory and report what it did.
 * The real implementation drives an agent CLI; tests use a deterministic fake so
 * CI never needs an API key.
 */
export interface AgentRunner {
  readonly id: string;
  /** Whether a run costs real money (drives the confirmation prompt). */
  readonly paid: boolean;
  run(req: RunRequest): Promise<Trace>;
  /** Free checks that a run can succeed at all (installed, authenticated). Optional. */
  preflight?(cwd: string): Promise<Check[]>;
}
