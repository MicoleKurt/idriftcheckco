import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { diffGroups } from '../diff/diff.js';
import { decideStop, describeStop, planLooks, type StopReason } from '../diff/sequential.js';
import type { DiffReport } from '../diff/types.js';
import type { Config } from '../config.js';
import { renderHtml } from '../report/html.js';
import { ClaudeCodeRunner } from '../replay/claude-runner.js';
import { estimateReplay, type ReplayEstimate } from '../replay/estimate.js';
import { FakeRunner, parseScenario } from '../replay/fake-runner.js';
import { resolveAllowedTools } from '../replay/permissions.js';
import { runReplay, storePersister, type ArmPlan } from '../replay/replay.js';
import { resolveAutoRef } from '../replay/worktree.js';
import type { AgentRunner } from '../replay/runner.js';
import type { Store} from '../store/store.js';
import { slug, type RunMeta } from '../store/store.js';
import type { Trace, Variant } from '../trace/schema.js';
import { fmtMetric } from '../util/format.js';
import { preflightOrThrow } from './checks.js';
import { UsageError, type Ctx } from './context.js';

export interface ExecuteArgs {
  ctx: Ctx;
  config: Config;
  store: Store;
  source: Trace;
  candidate: ArmPlan;
  /** Re-run the unchanged setup as the baseline (recommended). When false, the original session is the baseline. */
  control: boolean;
  controlVariant?: Variant;
  /** Commit to replay on; undefined or "auto" picks the commit the session started from. */
  ref?: string;
  /** Replay only the first prompt, or every human turn of the session. */
  turns?: 'first' | 'all';
  check?: string;
  maxCostUsd?: number;
  runner: AgentRunner;
  dryRun: boolean;
  /** `--runs auto`: candidate.runs is the maximum and the replay stops early when the answer is clear. */
  adaptive?: boolean;
  yes: boolean;
  /** Where overlay source paths resolve from. */
  baseDir: string;
  /** Override the HTML output path. */
  htmlPath?: string;
}

export interface ExecuteResult {
  runId?: string;
  estimate: ReplayEstimate;
  report?: DiffReport;
  baseline?: Trace[];
  candidate?: Trace[];
  reportPath?: string;
  truncated?: boolean;
  spentUsd?: number;
}

export function makeRunner(kind: string, config: Config, scenarioPath: string | undefined, seed: number | undefined, cwd: string): AgentRunner {
  if (kind === 'fake') {
    if (!scenarioPath) throw new UsageError('--runner fake needs --scenario <file.json>. See docs/testing-with-a-fake-agent.md.');
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(resolve(cwd, scenarioPath), 'utf8'));
    } catch (e) {
      throw new UsageError(`Could not read scenario ${scenarioPath}: ${(e as Error).message}`);
    }
    return new FakeRunner(parseScenario(raw, scenarioPath), seed ?? 1);
  }
  if (kind !== 'claude') throw new UsageError(`Unknown --runner "${kind}". Use "claude" or "fake".`);
  return new ClaudeCodeRunner({
    bin: config.claudeBin,
    binArgs: config.claudeArgs,
    permissionMode: config.permissionMode,
    envAllowlist: config.env,
    ...(config.prices ? { prices: config.prices } : {}),
  });
}

function usd(x: number | null): string {
  return x === null ? 'n/a' : fmtMetric('usd', x);
}

export function describeEstimate(e: ReplayEstimate, runner: AgentRunner, context: string[] = []): string {
  const lines = ['', ' Replay plan'];
  for (const c of context) lines.push(`   ${c}`);
  for (const a of e.arms) {
    lines.push(`   ${a.arm.padEnd(18)} ${String(a.runs).padStart(2)} run${a.runs === 1 ? ' ' : 's'}  ${(a.model ?? 'default model').padEnd(22)} ${usd(a.costUsd)}`);
  }
  if (runner.paid) {
    lines.push(`   ${'estimated total'.padEnd(18)} ${usd(e.totalUsd)}   (likely range ${usd(e.lowUsd)} to ${usd(e.highUsd)})`);
    if (e.minutes !== null) lines.push(`   ${'estimated time'.padEnd(18)} ~${e.minutes} min sequentially`);
  } else lines.push('   no API cost (fake agent)');
  for (const c of e.caveats) lines.push(`   · ${c}`);
  lines.push('');
  return lines.join('\n');
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Plan, estimate, confirm, run, store, diff, and write a report. */
export async function executeReplay(a: ExecuteArgs): Promise<ExecuteResult> {
  const { ctx, config, store, source } = a;
  const control: ArmPlan | undefined = a.control
    ? { name: 'control', variant: a.controlVariant ?? { name: 'control', ...(source.model ? { model: source.model } : {}) }, runs: a.candidate.runs }
    : undefined;
  const arms = control ? [control, a.candidate] : [a.candidate];

  // Realism: the code as it was, the tools the session had, and (optionally) every turn.
  const turns = a.turns ?? config.turns;
  const followUps = turns === 'all' ? source.followUps : [];
  const allowedTools = resolveAllowedTools(config.allowedTools, source);
  const refChoice =
    a.ref && a.ref !== 'auto'
      ? { ref: a.ref, note: `Replaying on ${a.ref} (set with --ref).` }
      : await resolveAutoRef(ctx.cwd, source.startedAt, source.gitBranch).catch(() => ({ ref: 'HEAD', note: 'Could not read git history; replaying on HEAD.' }));
  const context = [
    `code:  ${refChoice.note}`,
    `tools: ${allowedTools ? `${allowedTools.join(', ')} (as used in the original session)` : `decided by permissionMode "${config.permissionMode}"`}`,
    `turns: ${followUps.length > 0 ? `all ${followUps.length + 1} human turns` : source.followUps.length > 0 ? `first of ${source.followUps.length + 1} (add --turns all to replay the follow-ups)` : '1'}`,
  ];
  const plan = a.adaptive ? planLooks(config.alpha, a.candidate.runs) : undefined;
  const estimate = estimateReplay(source, arms, config.prices, { allTurns: followUps.length > 0 });
  // Adaptive runs may stop at the first look: price that best case too.
  const best = plan ? estimateReplay(source, arms.map((x) => ({ ...x, runs: plan.looks[0]! })), config.prices, { allTurns: followUps.length > 0 }) : undefined;
  if (plan) {
    context.push(
      `runs:  adaptive, ${plan.looks[0]} to ${plan.maxRuns} per side (looks at ${plan.looks.join(', ')}, alpha ${plan.alphaPerLook.toFixed(4)} each)` +
        (a.runner.paid && best?.totalUsd != null ? `; best case ${usd(best.totalUsd)}, worst case below` : ''),
    );
  }
  ctx.stderr(describeEstimate(estimate, a.runner, context));
  await preflightOrThrow(ctx, a.runner, a.dryRun);
  if (a.dryRun) {
    ctx.stderr(' Dry run: nothing was executed.');
    return { estimate };
  }
  if (a.runner.paid && !a.yes) {
    const ok = await ctx.confirm('This will spend real money on API calls. Continue?');
    if (!ok) {
      throw new UsageError(
        ctx.interactive
          ? 'Cancelled. Nothing was run.'
          : 'Replay costs money and no terminal is attached to confirm. Re-run with --yes to proceed, or --dry-run to see the estimate.',
      );
    }
  }
  const floor = (best ?? estimate).lowUsd;
  if (a.maxCostUsd !== undefined && estimate.totalUsd !== null && floor !== null && floor > a.maxCostUsd) {
    throw new UsageError(
      `The low-end estimate ($${floor.toFixed(2)}) already exceeds --max-cost $${a.maxCostUsd.toFixed(2)}. Reduce --runs, pick a cheaper model, or raise the cap.`,
    );
  }

  const runId = `${slug(source.id.slice(0, 8))}-${slug(a.candidate.name)}-${stamp()}`;
  const meta: RunMeta = {
    schemaVersion: 1, runId, createdAt: new Date().toISOString(), sourceTraceId: source.id, task: source.task,
    ref: refChoice.ref, runner: a.runner.id, runsPerArm: a.candidate.runs,
    arms: [
      ...(control ? [{ name: control.name, variant: control.variant }] : [{ name: 'original', variant: { name: 'original', ...(source.model ? { model: source.model } : {}) } }]),
      { name: a.candidate.name, variant: a.candidate.variant },
    ],
    notes: [],
  };
  await store.saveRunMeta(meta);

  const checkCmd = a.check ?? config.check;
  const maxCost = a.maxCostUsd ?? config.maxCostUsd;
  const common = {
    repo: ctx.cwd,
    ref: refChoice.ref,
    task: source.task,
    ...(allowedTools ? { allowedTools } : {}),
    ...(followUps.length > 0 ? { followUps } : {}),
    runner: a.runner,
    ...(checkCmd ? { check: checkCmd } : {}),
    timeoutMs: Math.round(config.timeoutMinutes * 60_000),
    baseDir: a.baseDir,
    persist: storePersister(store, runId),
  };
  const result: { arms: Record<string, Trace[]>; spentUsd: number; truncated: boolean; notes: string[] } = { arms: {}, spentUsd: 0, truncated: false, notes: [] };
  let adaptiveNote: string | undefined;

  if (!plan) {
    const r = await runReplay({
      ...common, arms, ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}),
      onProgress: (e) => {
        if (!e.trace) ctx.stderr(`  [${e.index + 1}/${e.total}] ${e.arm} …`);
        else ctx.stderr(`  [${e.index}/${e.total}] ${e.arm} done · ${e.trace.outcome.status} · ${usd(e.trace.costUsd)} · spent ${usd(e.spentUsd)}`);
      },
    });
    Object.assign(result, r);
  } else {
    // Interleave the arms one run at a time so drift over time hits both sides equally.
    let done = 0;
    let reason: StopReason = 'continue';
    outer: for (const [i, look] of plan.looks.entries()) {
      while (done < look) {
        const remaining = maxCost === undefined ? undefined : maxCost - result.spentUsd;
        const r = await runReplay({
          ...common, arms: arms.map((x) => ({ ...x, runs: 1 })), indexOffset: done,
          ...(remaining !== undefined ? { maxCostUsd: Math.max(0, remaining) } : {}),
          onProgress: (e) => {
            if (e.trace) ctx.stderr(`  run ${done + 1} · ${e.arm} done · ${e.trace.outcome.status} · ${usd(e.trace.costUsd)} · spent ${usd(result.spentUsd + e.spentUsd)}`);
          },
        });
        for (const [arm, traces] of Object.entries(r.arms)) (result.arms[arm] ??= []).push(...traces);
        result.spentUsd += r.spentUsd;
        result.notes.push(...r.notes);
        if (r.truncated) {
          result.truncated = true;
          break outer;
        }
        done++;
      }
      const sideA = control ? (result.arms[control.name] ?? []) : [source];
      const sideB = result.arms[a.candidate.name] ?? [];
      if (sideA.length === 0 || sideB.length === 0) break;
      reason = decideStop(diffGroups(sideA, sideB, { alpha: plan.alphaPerLook, softThreshold: config.softThreshold }), i === plan.looks.length - 1);
      ctx.stderr(`  look at ${done} runs per side: ${reason === 'continue' ? 'evidence mixed, continuing' : reason}`);
      if (reason !== 'continue') break;
    }
    adaptiveNote = describeStop(reason === 'continue' ? 'max-runs' : reason, done, plan);
  }
  for (const n of result.notes) ctx.stderr(`  ! ${n}`);
  const authNote = Object.values(result.arms).flat().flatMap((t) => t.notes).find((n) => n.startsWith('The agent CLI could not authenticate'));
  if (authNote) ctx.stderr(`  ! ${authNote}`);

  const baseline = control ? (result.arms[control.name] ?? []) : [source];
  if (!control) await store.saveRunTrace(runId, 'original', 0, source);
  const candidate = result.arms[a.candidate.name] ?? [];
  if (baseline.length === 0 || candidate.length === 0) {
    throw new Error(`Replay produced no complete runs for ${baseline.length === 0 ? 'the baseline' : 'the candidate'}. ${result.notes.join(' ')} Nothing to compare; see .idriftcheckco/runs/${runId}.`);
  }
  const report = diffGroups(baseline, candidate, { alpha: plan ? plan.alphaPerLook : config.alpha, softThreshold: config.softThreshold });
  if (adaptiveNote) report.notes.unshift(adaptiveNote);
  if (!control) report.notes.unshift('Baseline is the original human session, not a re-run; follow-up turns and repo state differ. Use control runs (default) for a fair comparison.');
  const html = renderHtml(report, { baseline, candidate, generatedAt: new Date().toISOString() });
  let reportPath: string;
  if (a.htmlPath) {
    await writeFile(a.htmlPath, html, 'utf8');
    reportPath = a.htmlPath;
  } else reportPath = await store.writeReport(runId, html);
  return { runId, estimate, report, baseline, candidate, reportPath, truncated: result.truncated, spentUsd: result.spentUsd };
}
