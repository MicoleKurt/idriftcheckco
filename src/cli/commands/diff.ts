import { existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../../config.js';
import { diffGroups, exitCodeFor } from '../../diff/diff.js';
import type { DiffReport } from '../../diff/types.js';
import { renderHtml } from '../../report/html.js';
import { renderJson } from '../../report/json.js';
import { renderMarkdown } from '../../report/markdown.js';
import { renderTerminal } from '../../report/terminal.js';
import { loadTraceDir, Store } from '../../store/store.js';
import type { Trace } from '../../trace/schema.js';
import { parse, UsageError, type Ctx } from '../context.js';
import { failOn } from './replay.js';

export const DIFF_HELP = `idriftcheckco diff <a> [b]

Compare two sets of runs. Each side can be:
  a trace file            one run
  a directory             every *.json trace inside it
  <runId>:<arm>           one arm of a stored replay run
  a stored trace id       an imported session
With ONE argument (a run id or "latest") compares that run's first and last arm.

Options
  --format <f>      terminal (default) | json | markdown | html
  --out <file>      Write output to a file instead of stdout
  --fail-on <lvl>   Exit 1 on regression (or drift)
`;

export async function resolveGroup(store: Store, ref: string, cwd: string): Promise<{ label: string; traces: Trace[] }> {
  const abs = resolve(cwd, ref);
  const colon = ref.lastIndexOf(':');
  if (colon > 0 && !existsSync(abs)) {
    const { arms } = await store.loadRun(ref.slice(0, colon));
    const arm = ref.slice(colon + 1);
    const traces = arms[arm];
    if (!traces) throw new UsageError(`Run "${ref.slice(0, colon)}" has no arm "${arm}". Arms: ${Object.keys(arms).join(', ')}.`);
    return { label: arm, traces };
  }
  if (existsSync(abs) && statSync(abs).isDirectory()) return { label: ref, traces: await loadTraceDir(abs) };
  return { label: ref, traces: [await store.resolveTrace(ref)] };
}

export async function diffRun(
  store: Store,
  runId: string,
  opts: { alpha: number; softThreshold: number },
): Promise<{ report: DiffReport; baseline: Trace[]; candidate: Trace[]; runId: string }> {
  const { meta, arms } = await store.loadRun(runId);
  const first = meta.arms[0]!.name;
  const last = meta.arms[meta.arms.length - 1]!.name;
  const baseline = arms[first] ?? [];
  const candidate = arms[last] ?? [];
  return { runId: meta.runId, baseline, candidate, report: diffGroups(baseline, candidate, opts) };
}

export function formatReport(
  format: string, report: DiffReport, ctx: Ctx, traces: { baseline: Trace[]; candidate: Trace[] }, fail: 'regression' | 'drift' | undefined,
): string {
  switch (format) {
    case 'terminal':
      return renderTerminal(report, { color: ctx.color });
    case 'json':
      return renderJson(report, fail ?? 'regression');
    case 'markdown':
      return renderMarkdown(report);
    case 'html':
      return renderHtml(report, { ...traces, generatedAt: new Date().toISOString() });
    default:
      throw new UsageError(`Unknown --format "${format}". Use terminal, json, markdown or html.`);
  }
}

export async function diffCommand(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    options: { format: { type: 'string', default: 'terminal' }, out: { type: 'string' }, 'fail-on': { type: 'string' }, help: { type: 'boolean' } },
  }, 'diff');
  if (values.help) {
    ctx.stdout(DIFF_HELP);
    return 0;
  }
  if (positionals.length < 1 || positionals.length > 2) throw new UsageError('Pass one run id, or two things to compare. See `idriftcheckco diff --help`.');
  const { config } = await loadConfig(ctx.cwd);
  const store = new Store(ctx.cwd, config.storeDir);
  let report: DiffReport;
  let baseline: Trace[];
  let candidate: Trace[];
  if (positionals.length === 1) {
    ({ report, baseline, candidate } = await diffRun(store, positionals[0]!, config));
  } else {
    const a = await resolveGroup(store, positionals[0]!, ctx.cwd);
    const b = await resolveGroup(store, positionals[1]!, ctx.cwd);
    baseline = a.traces;
    candidate = b.traces;
    report = diffGroups(baseline, candidate, { alpha: config.alpha, softThreshold: config.softThreshold });
  }
  const fail = failOn(values['fail-on']);
  const text = formatReport(values.format, report, ctx, { baseline, candidate }, fail);
  if (values.out) {
    await writeFile(resolve(ctx.cwd, values.out), text, 'utf8');
    ctx.stderr(`Wrote ${values.out}`);
  } else ctx.stdout(text);
  return fail ? exitCodeFor(report.verdict, fail) : 0;
}
