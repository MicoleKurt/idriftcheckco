import { listSessionFiles, loadSession, type SessionFile } from './adapters/discover.js';
import { replayability, type Replayability } from './adapters/rank.js';
import { median } from './diff/stats.js';
import type { Price } from './trace/pricing.js';
import { isVerificationCommand } from './trace/classify.js';
import { toolCalls, type Trace } from './trace/schema.js';
import { fmtMetric, stripAnsi } from './util/format.js';

export interface ScanEntry {
  file: SessionFile;
  trace: Trace;
  rank: Replayability;
}

export interface ScanOptions {
  root: string;
  /** Working directory whose sessions to scan; undefined scans every project. */
  project?: string;
  /** Newest N sessions are parsed. */
  limit?: number;
  prices?: Record<string, Price>;
  onProgress?: (done: number, total: number) => void;
}

/** Parse the newest sessions and score their replayability. Unreadable files are skipped. */
export async function scanSessions(opts: ScanOptions): Promise<{ entries: ScanEntry[]; totalFiles: number; skipped: number }> {
  const files = await listSessionFiles(opts.root, opts.project);
  const picked = files.slice(0, opts.limit ?? 40);
  const entries: ScanEntry[] = [];
  let skipped = 0;
  for (const [i, file] of picked.entries()) {
    try {
      const trace = await loadSession(file, opts.prices);
      // Sessions with no human prompt and no tool calls (e.g. empty or only metadata) are noise.
      if (trace.steps.length === 0) {
        skipped++;
        continue;
      }
      entries.push({ file, trace, rank: replayability(trace) });
    } catch {
      skipped++;
    }
    opts.onProgress?.(i + 1, picked.length);
  }
  return { entries, totalFiles: files.length, skipped };
}

export interface ModelRow {
  model: string;
  sessions: number;
  medianToolCalls: number;
  /** Share of sessions that ran a test/build/lint command. */
  verifiedRate: number;
  completedRate: number;
  medianCostUsd: number | null;
}

/** Observational per-model behaviour summary. Tasks differ between sessions, so this is a hint, not a test. */
export function modelSummary(entries: ScanEntry[]): ModelRow[] {
  const byModel = new Map<string, Trace[]>();
  for (const { trace } of entries) {
    const key = trace.model ?? 'unknown';
    byModel.set(key, [...(byModel.get(key) ?? []), trace]);
  }
  return [...byModel.entries()]
    .map(([model, ts]) => {
      const costs = ts.map((t) => t.costUsd).filter((c): c is number => c !== null);
      return {
        model,
        sessions: ts.length,
        medianToolCalls: median(ts.map((t) => toolCalls(t).length)),
        verifiedRate: ts.filter((t) => toolCalls(t).some((c) => c.category === 'exec' && c.target && isVerificationCommand(c.target))).length / ts.length,
        completedRate: ts.filter((t) => t.outcome.status === 'completed').length / ts.length,
        medianCostUsd: costs.length ? median(costs) : null,
      };
    })
    .sort((a, b) => b.sessions - a.sessions);
}

function clipTask(task: string, n: number): string {
  const one = task.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

export interface RenderScanOptions {
  color?: boolean;
  top?: number;
  width?: number;
}

/** Render the zero-config first screen. */
export function renderScan(
  entries: ScanEntry[],
  meta: { totalFiles: number; skipped: number; scope: string },
  opts: RenderScanOptions = {},
): string {
  const c = (s: string, code: number) => (opts.color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const bold = (s: string) => c(s, 1);
  const dim = (s: string) => c(s, 90);
  const out: string[] = [];
  out.push('');
  out.push(` ${bold('idriftcheckco')} ${dim('· found')} ${bold(String(entries.length))} ${dim(`usable session${entries.length === 1 ? '' : 's'} in ${meta.scope} (${meta.totalFiles} files, ${meta.skipped} skipped)`)}`);
  out.push('');

  if (entries.length === 0) {
    out.push('  No sessions to analyze yet.');
    out.push(dim('  Run your agent on a task in this repo first, or point at another folder with --sessions <dir>.'));
    out.push(dim('  No sessions handy? Try the offline demo: npx idriftcheckco demo'));
    out.push('');
    return out.join('\n');
  }

  const rows = modelSummary(entries);
  if (rows.length > 1) {
    out.push(` ${bold('YOUR AGENT BY MODEL')} ${dim('observational: tasks differ between sessions')}`);
    const head = ['model', 'sessions', 'tool calls', 'ran tests', 'finished', 'cost'];
    const body = rows.map((r) => [
      r.model, String(r.sessions), fmtMetric('count', r.medianToolCalls),
      `${Math.round(r.verifiedRate * 100)}%`, `${Math.round(r.completedRate * 100)}%`,
      r.medianCostUsd === null ? 'n/a' : fmtMetric('usd', r.medianCostUsd),
    ]);
    const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
    out.push(dim('  ' + head.map((h, i) => (i === 0 ? h.padEnd(w[i]!) : h.padStart(w[i]!))).join('  ')));
    for (const b of body) out.push('  ' + b.map((x, i) => (i === 0 ? x.padEnd(w[i]!) : x.padStart(w[i]!))).join('  '));
    out.push('');
  }

  const ranked = [...entries].sort((a, b) => b.rank.score - a.rank.score).slice(0, opts.top ?? 6);
  out.push(` ${bold('BEST SESSIONS TO REPLAY')} ${dim('score = how well it suits an automated re-run')}`);
  for (const e of ranked) {
    const id = e.file.sessionId.slice(0, 8);
    const score = String(e.rank.score).padStart(3);
    out.push(`  ${bold(score)}  ${dim(id)}  ${clipTask(stripAnsi(e.trace.task), (opts.width ?? 88) - 22)}`);
    const why = [...e.rank.reasons.slice(0, 3)].join(', ');
    const warn = e.rank.warnings[0];
    out.push(dim(`        ${why}${warn ? ` · caution: ${warn}` : ''}`));
  }
  out.push('');
  const best = ranked[0]!;
  out.push(` ${bold('NEXT')}`);
  out.push(`  ${dim('1.')} npx idriftcheckco import ${best.file.sessionId.slice(0, 8)}`);
  out.push(`  ${dim('2.')} npx idriftcheckco replay ${best.file.sessionId.slice(0, 8)} --model <new-model> --dry-run   ${dim('# shows the cost first')}`);
  out.push(`  ${dim('Want to see a report right now, free and offline?')} npx idriftcheckco demo`);
  out.push('');
  return out.join('\n');
}
