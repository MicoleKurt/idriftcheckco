import { commandSignature, isVerificationCommand } from '../trace/classify.js';
import type { Trace } from '../trace/schema.js';

/**
 * Reduce a trace to the sequence of events that matter when comparing behavior.
 * Reads and searches are deliberately excluded: doing them in a different order is
 * noise. Consecutive duplicates collapse (ten edits to one file are one milestone).
 */
export function milestones(trace: Trace): string[] {
  const out: string[] = [];
  const push = (m: string) => {
    if (out[out.length - 1] !== m) out.push(m);
  };
  for (const s of trace.steps) {
    const t = s.tool;
    if (!t) continue;
    switch (t.category) {
      case 'write':
        push(`write:${t.target ?? t.name}`);
        break;
      case 'exec':
        push(`exec:${commandSignature(t.target ?? '')}`);
        break;
      case 'mcp':
        push(`mcp:${t.name}`);
        break;
      case 'agent':
        push(`agent:${t.target ?? t.name}`);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Milestone keys as a set, for prevalence comparison across runs. */
export function milestoneSet(trace: Trace): Set<string> {
  return new Set(milestones(trace));
}

export function isVerificationMilestone(m: string): boolean {
  return m.startsWith('exec:') && isVerificationCommand(m.slice(5));
}

export interface AlignOp {
  op: 'same' | 'removed' | 'added';
  value: string;
}

/** LCS-based alignment of two milestone sequences, for side-by-side display. */
export function alignMilestones(a: readonly string[], b: readonly string[]): AlignOp[] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: AlignOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ op: 'same', value: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ op: 'removed', value: a[i++]! });
    } else {
      ops.push({ op: 'added', value: b[j++]! });
    }
  }
  while (i < a.length) ops.push({ op: 'removed', value: a[i++]! });
  while (j < b.length) ops.push({ op: 'added', value: b[j++]! });
  return ops;
}
