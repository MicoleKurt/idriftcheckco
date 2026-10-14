import { isVerificationCommand } from '../trace/classify.js';
import { toolCalls, type Trace } from '../trace/schema.js';

export interface Replayability {
  /** 0 to 100. How well this session suits an automated replay. */
  score: number;
  reasons: string[];
  warnings: string[];
}

/**
 * Score how suitable a recorded session is for replay. Replay only re-runs the first
 * task, with no human in the loop, so the best candidates are self-contained tasks
 * that changed files and verified their own work.
 */
export function replayability(t: Trace): Replayability {
  let score = 0;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const calls = toolCalls(t);

  if (t.task.length >= 20 && t.task.length <= 3000 && !t.task.startsWith('(no prompt')) {
    score += 15;
    reasons.push('clear task');
  } else warnings.push('task prompt missing or unusual length');

  if (t.humanTurns <= 1) {
    score += 20;
    reasons.push('single prompt');
  } else if (t.humanTurns <= 3) {
    score += 8;
    warnings.push(`${t.humanTurns} human turns; only the first is replayed`);
  } else warnings.push(`${t.humanTurns} human turns; replay would cover only the first`);

  if (t.filesChanged.length > 0) {
    score += 20;
    reasons.push(`changed ${t.filesChanged.length} file${t.filesChanged.length === 1 ? '' : 's'}`);
  } else warnings.push('changed no files, so there is little to compare');

  if (calls.some((c) => c.category === 'exec' && c.target && isVerificationCommand(c.target))) {
    score += 20;
    reasons.push('ran its own tests/build');
  }

  if (t.outcome.status === 'completed') {
    score += 10;
    reasons.push('finished');
  } else warnings.push(`ended as ${t.outcome.status}`);

  if (calls.length >= 3 && calls.length <= 80) score += 10;
  else warnings.push(calls.length < 3 ? 'very few tool calls' : 'very long session (expensive to replay)');

  const external = calls.filter((c) => c.category === 'mcp' || c.category === 'web').length;
  if (external > 0) {
    score -= Math.min(20, external * 4);
    warnings.push(`${external} MCP/web call${external === 1 ? '' : 's'} may not reproduce`);
  }
  if (t.costUsd !== null && t.costUsd <= 2) score += 5;

  return { score: Math.max(0, Math.min(100, score)), reasons, warnings };
}
