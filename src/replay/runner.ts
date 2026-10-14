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
}
