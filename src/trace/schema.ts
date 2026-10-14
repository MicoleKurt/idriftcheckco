import { z } from 'zod';

/** Bump when the on-disk Trace shape changes incompatibly. */
export const TRACE_SCHEMA_VERSION = 1 as const;

/** Coarse tool taxonomy. Diffing works on categories so it survives tool renames. */
export const ToolCategorySchema = z.enum([
  'read',
  'write',
  'search',
  'exec',
  'mcp',
  'agent',
  'web',
  'other',
]);
export type ToolCategory = z.infer<typeof ToolCategorySchema>;

/** One tool invocation together with its (redacted, truncated) result. */
export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: ToolCategorySchema,
  /** File path, command, or pattern the call acted on. */
  target: z.string().optional(),
  /** Redacted tool input. */
  args: z.record(z.string(), z.unknown()),
  ok: z.boolean(),
  resultPreview: z.string(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const StepSchema = z.object({
  index: z.number().int().nonnegative(),
  at: z.string().optional(),
  kind: z.enum(['text', 'tool']),
  text: z.string().optional(),
  tool: ToolCallSchema.optional(),
});
export type Step = z.infer<typeof StepSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

/** Result of the optional user-supplied verification command (e.g. `pnpm test`). */
export const CheckResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  outputTail: z.string().optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const OutcomeSchema = z.object({
  /**
   * `completed` means the agent stopped on its own. It does NOT mean the work is
   * correct; correctness signals come from `check` and from file diffs.
   */
  status: z.enum(['completed', 'error', 'interrupted', 'unknown']),
  finalMessage: z.string().optional(),
  check: CheckResultSchema.optional(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

export const VariantSchema = z.object({
  name: z.string(),
  model: z.string().optional(),
  promptFile: z.string().optional(),
  mcpConfig: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
  /** Files copied into the replay worktree before the run: destination -> source path (e.g. CLAUDE.md). */
  files: z.record(z.string(), z.string()).optional(),
});
export type Variant = z.infer<typeof VariantSchema>;

/**
 * The normalized record of one agent run. Everything downstream (diff, report, CI)
 * depends only on this type, never on a vendor transcript format.
 */
export const TraceSchema = z.object({
  schemaVersion: z.literal(TRACE_SCHEMA_VERSION),
  id: z.string(),
  label: z.string().optional(),
  source: z.object({
    kind: z.enum(['claude-code', 'replay', 'fake']),
    adapter: z.string(),
    sessionId: z.string().optional(),
    sourceVersion: z.string().optional(),
  }),
  variant: VariantSchema.optional(),
  task: z.string(),
  /** Number of human prompts in the original session. Replay covers only the first. */
  humanTurns: z.number().int().nonnegative(),
  /** Human prompts after the first, in order (redacted). Replayed with `--turns all`. */
  followUps: z.array(z.string()).default([]),
  /** Git branch the session ran on, when known. Used by `--ref auto`. */
  gitBranch: z.string().optional(),
  model: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  durationMs: z.number().nonnegative().nullable(),
  steps: z.array(StepSchema),
  usage: UsageSchema,
  /** USD. `null` when the model is unknown to the price table. */
  costUsd: z.number().nonnegative().nullable(),
  costSource: z.enum(['reported', 'estimated', 'unknown']),
  filesChanged: z.array(z.string()),
  filesRead: z.array(z.string()),
  outcome: OutcomeSchema,
  notes: z.array(z.string()),
});
export type Trace = z.infer<typeof TraceSchema>;

/** Parse and validate untrusted JSON as a Trace. Throws a readable error. */
export function parseTrace(input: unknown, origin = 'trace'): Trace {
  const res = TraceSchema.safeParse(input);
  if (!res.success) {
    const issue = res.error.issues[0];
    const where = issue ? issue.path.join('.') || '(root)' : '(root)';
    throw new Error(
      `Invalid ${origin}: ${issue?.message ?? 'schema mismatch'} at ${where}. ` +
        `Re-import it with \`idriftcheckco import\` or check that the file was produced by this version.`,
    );
  }
  return res.data;
}

/** Number of tool calls in a trace. */
export function toolCalls(trace: Trace): ToolCall[] {
  const out: ToolCall[] = [];
  for (const s of trace.steps) if (s.tool) out.push(s.tool);
  return out;
}
