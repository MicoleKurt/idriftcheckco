import { toolCalls, type Trace } from '../trace/schema.js';

/** Tool names safe to pass on a command line (built-ins and `mcp__server__tool`). */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The tools a replay may use without asking: exactly the tools the original session
 * used. Without this, a headless replay in `acceptEdits` mode cannot run commands the
 * original session ran (for example the test suite), so the replay would diverge from
 * reality for reasons that have nothing to do with the model.
 *
 * Shell access is granted as a whole tool when the session used it: per-command
 * matching would silently deny commands the new model phrases differently, which is
 * exactly the behaviour under test. Every arm gets the same set, so the comparison
 * stays fair; the replay still runs in a throwaway worktree with a filtered environment.
 */
export function toolsFromTrace(trace: Trace): string[] {
  const names = new Set<string>();
  for (const call of toolCalls(trace)) if (TOOL_NAME.test(call.name)) names.add(call.name);
  return [...names].sort();
}

export type ToolPolicy = 'session' | 'none' | string[];

/** Resolve the configured policy into the list passed to the agent (undefined = no flag). */
export function resolveAllowedTools(policy: ToolPolicy, source: Trace): string[] | undefined {
  if (policy === 'none') return undefined;
  const tools = policy === 'session' ? toolsFromTrace(source) : policy.filter((t) => TOOL_NAME.test(t));
  return tools.length > 0 ? tools : undefined;
}
