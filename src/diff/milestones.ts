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
