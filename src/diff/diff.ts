import { totalTokens } from '../trace/pricing.js';
import { fmtMetric, fmtP, pct } from '../util/format.js';
import { toolCalls, type Trace } from '../trace/schema.js';
import { isVerificationMilestone, milestones, milestoneSet } from './milestones.js';
import {
  choose,
  fisherExact,
  mean,
  permutationPValue,
  relativeChange,
  sequenceSimilarity,
  summarize,
} from './stats.js';
import type {
  DiffOptions,
  DiffReport,
  Evidence,
  FileComparison,
  Finding,
  GroupInfo,
  MetricComparison,
  MetricName,
  SequenceComparison,
  Verdict,
} from './types.js';

const DEFAULTS = { alpha: 0.05, softThreshold: 0.25, seed: 1 };

/** Smallest n per arm where complete separation reaches p < alpha (exact permutation). */
export function minRunsForSignificance(alpha: number): number {
  for (let n = 2; n <= 50; n++) if (2 / choose(2 * n, n) < alpha) return n;
  return 50;
}

function rate(count: number, n: number): number {
  return n === 0 ? 0 : count / n;
}

/** Evidence for a difference in proportions, or undefined when it is too small to report. */
function proportionEvidence(p: number | null, rateDiff: number, alpha: number): Evidence | undefined {
  if (p !== null && p < alpha) return 'strong';
  if (Math.abs(rateDiff) >= 0.5) return 'weak';
  return undefined;
}

function groupInfo(label: string, traces: Trace[]): GroupInfo {
  const models = [...new Set(traces.map((t) => t.model).filter((m): m is string => !!m))].sort();
  return { label, n: traces.length, models, traceIds: traces.map((t) => t.id) };
}

function labelOf(traces: Trace[], fallback: string): string {
  return traces.find((t) => t.variant?.name)?.variant?.name ?? traces[0]?.label ?? fallback;
}

const METRICS: Array<{
  name: MetricName;
  label: string;
  unit: MetricComparison['unit'];
  pick: (t: Trace) => number | null;
  /** Smallest absolute change of the mean worth reporting. */
  floor: number;
  /** Whether a decrease is an improvement (cost) or just a change (step count). */
  lowerIsBetter: boolean;
}> = [
  { name: 'toolCalls', label: 'Tool calls', unit: 'count', pick: (t) => toolCalls(t).length, floor: 1, lowerIsBetter: false },
  { name: 'costUsd', label: 'Cost', unit: 'usd', pick: (t) => t.costUsd, floor: 0.01, lowerIsBetter: true },
  { name: 'totalTokens', label: 'Tokens', unit: 'tokens', pick: (t) => totalTokens(t.usage), floor: 500, lowerIsBetter: true },
  { name: 'durationMs', label: 'Duration', unit: 'ms', pick: (t) => t.durationMs, floor: 2000, lowerIsBetter: true },
  { name: 'toolErrors', label: 'Tool errors', unit: 'count', pick: (t) => toolCalls(t).filter((c) => !c.ok).length, floor: 1, lowerIsBetter: true },
];

function pairwiseSimilarity(a: string[][], b: string[][]): number {
  const sims: number[] = [];
  for (const x of a) for (const y of b) sims.push(sequenceSimilarity(x, y));
  return mean(sims);
}

function withinSimilarity(runs: string[][]): number | null {
  if (runs.length < 2) return null;
  const sims: number[] = [];
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) sims.push(sequenceSimilarity(runs[i]!, runs[j]!));
  }
  return mean(sims);
}

/**
 * Compare two groups of runs (baseline vs candidate).
 *
 * Findings are split into HARD (different files, completion, failing check) and
 * SOFT (cost, steps, tokens, time, tool order). Every finding carries an evidence
 * level; with few runs most effects can only be `weak`, and the report says so.
 */
export function diffGroups(baseline: Trace[], candidate: Trace[], options: DiffOptions = {}): DiffReport {
  const { alpha, softThreshold, seed } = { ...DEFAULTS, ...options };
  if (baseline.length === 0 || candidate.length === 0) {
    throw new Error(
      'Both sides of a diff need at least one run. Pass a trace file, a run directory, or a glob that matches traces.',
    );
  }
  const nB = baseline.length;
  const nC = candidate.length;
  const findings: Finding[] = [];
  const notes: string[] = [];
  const minRuns = minRunsForSignificance(alpha);

  // ---- hard: files --------------------------------------------------------
  const paths = new Set<string>();
  for (const t of [...baseline, ...candidate]) for (const f of t.filesChanged) paths.add(f);
  const files: FileComparison[] = [];
  for (const path of [...paths].sort()) {
    const b = baseline.filter((t) => t.filesChanged.includes(path)).length;
    const c = candidate.filter((t) => t.filesChanged.includes(path)).length;
    const p = fisherExact(b, nB, c, nC);
    files.push({ path, baselineRate: rate(b, nB), candidateRate: rate(c, nC), p });
    const diff = rate(b, nB) - rate(c, nC);
    const evidence = proportionEvidence(p, diff, alpha);
    if (!evidence) continue;
    const counts = `${b}/${nB} → ${c}/${nC}`;
    if (diff > 0) {
      findings.push({
        id: `file-missing:${path}`, kind: 'file-missing', severity: 'hard', evidence, direction: 'worse',
        title: `No longer changes ${path}`,
        detail: `The baseline changed this file in ${b}/${nB} runs; the candidate in ${c}/${nC} (${counts})${fmtP(p)}.`,
        ...(p !== null ? { p } : {}),
      });
    } else {
      findings.push({
        id: `file-unexpected:${path}`, kind: 'file-unexpected', severity: 'hard', evidence, direction: 'worse',
        title: `Now changes ${path}`,
        detail: `The baseline changed this file in ${b}/${nB} runs; the candidate in ${c}/${nC} (${counts})${fmtP(p)}.`,
        ...(p !== null ? { p } : {}),
      });
    }
  }

  // ---- hard: completion ---------------------------------------------------
  const doneB = baseline.filter((t) => t.outcome.status === 'completed').length;
  const doneC = candidate.filter((t) => t.outcome.status === 'completed').length;
  {
    const p = fisherExact(doneB, nB, doneC, nC);
    const diff = rate(doneB, nB) - rate(doneC, nC);
    const evidence = diff > 0 ? proportionEvidence(p, diff, alpha) : undefined;
    if (evidence) {
      findings.push({
        id: 'completion', kind: 'completion', severity: 'hard', evidence, direction: 'worse',
        title: 'Agent finishes less often',
        detail: `Stopped on its own in ${doneC}/${nC} candidate runs versus ${doneB}/${nB} baseline runs${fmtP(p)}. The rest errored, were interrupted, or ended mid-task.`,
        ...(p !== null ? { p } : {}),
      });
    }
  }

  // ---- hard: verification command -----------------------------------------
  const checked = (ts: Trace[]) => ts.filter((t) => t.outcome.check);
  const cB = checked(baseline);
  const cC = checked(candidate);
  if (cB.length > 0 && cC.length > 0) {
    const passB = cB.filter((t) => t.outcome.check!.exitCode === 0).length;
    const passC = cC.filter((t) => t.outcome.check!.exitCode === 0).length;
    const p = fisherExact(passB, cB.length, passC, cC.length);
    const diff = rate(passB, cB.length) - rate(passC, cC.length);
    const evidence = diff > 0 ? proportionEvidence(p, diff, alpha) : undefined;
    if (evidence) {
      findings.push({
        id: 'check', kind: 'check', severity: 'hard', evidence, direction: 'worse',
        title: `\`${cC[0]!.outcome.check!.command}\` fails more often`,
        detail: `Passes in ${passC}/${cC.length} candidate runs versus ${passB}/${cB.length} baseline runs${fmtP(p)}.`,
        ...(p !== null ? { p } : {}),
      });
    }
  }

  // ---- soft: milestones and verification ------------------------------------
  const setsB = baseline.map(milestoneSet);
  const setsC = candidate.map(milestoneSet);
  const keys = new Set<string>();
  for (const s of [...setsB, ...setsC]) for (const k of s) if (!k.startsWith('write:')) keys.add(k);
  for (const key of [...keys].sort()) {
    const b = setsB.filter((s) => s.has(key)).length;
    const c = setsC.filter((s) => s.has(key)).length;
    const p = fisherExact(b, nB, c, nC);
    const diff = rate(b, nB) - rate(c, nC);
    const evidence = proportionEvidence(p, diff, alpha);
    if (!evidence) continue;
    const label = key.replace(/^[a-z]+:/, '');
    const verification = diff > 0 && isVerificationMilestone(key);
    if (verification) {
      findings.push({
        id: `verification-dropped:${key}`, kind: 'verification-dropped', severity: 'soft', evidence, direction: 'worse',
        title: `Stops running \`${label}\``,
        detail: `Verification step present in ${b}/${nB} baseline runs but ${c}/${nC} candidate runs${fmtP(p)}. Bugs can now ship unnoticed.`,
        ...(p !== null ? { p } : {}),
      });
    } else {
      findings.push({
        id: `milestone:${key}`, kind: 'milestone', severity: 'soft', evidence, direction: 'neutral',
        title: diff > 0 ? `Stops using ${label}` : `Starts using ${label}`,
        detail: `${key} appears in ${b}/${nB} baseline runs and ${c}/${nC} candidate runs${fmtP(p)}.`,
        ...(p !== null ? { p } : {}),
      });
    }
  }

  // ---- soft: sequence ---------------------------------------------------
  const seqB = baseline.map(milestones);
  const seqC = candidate.map(milestones);
  const sequence: SequenceComparison = {
    within: withinSimilarity(seqB),
    across: pairwiseSimilarity(seqB, seqC),
    baselineMilestones: seqB[0] ?? [],
    candidateMilestones: seqC[0] ?? [],
  };
  const floor = sequence.within ?? 1;
  if (sequence.across < 0.7 && sequence.across < floor - 0.15) {
    findings.push({
      id: 'sequence', kind: 'sequence', severity: 'soft', evidence: 'weak', direction: 'neutral',
      title: 'Different order of work',
      detail:
        `Step-sequence similarity is ${Math.round(sequence.across * 100)}%` +
        (sequence.within !== null ? ` versus ${Math.round(sequence.within * 100)}% between baseline runs (the noise floor)` : '') +
        '. Heuristic, not a significance test.',
    });
  }

  // ---- soft: numeric metrics ---------------------------------------------
  const metrics: MetricComparison[] = [];
  for (const m of METRICS) {
    const vb = baseline.map(m.pick).filter((v): v is number => v !== null);
    const vc = candidate.map(m.pick).filter((v): v is number => v !== null);
    if (vb.length === 0 || vc.length === 0) continue;
    const sb = summarize(vb);
    const sc = summarize(vc);
    const change = relativeChange(sb.mean, sc.mean);
    const p = permutationPValue(vb, vc, { seed });
    metrics.push({ name: m.name, label: m.label, unit: m.unit, baseline: sb, candidate: sc, values: { baseline: vb, candidate: vc }, change, p });
    const delta = sc.mean - sb.mean;
    // A zero baseline has no relative change; an absolute jump past the floor still counts.
    const big = change === null ? Math.abs(delta) >= m.floor : Math.abs(change) >= softThreshold;
    if (Math.abs(delta) < m.floor || !big) continue;
    const evidence: Evidence = p !== null && p < alpha ? 'strong' : 'weak';
    const increased = delta > 0;
    const direction = m.lowerIsBetter ? (increased ? 'worse' : 'better') : 'neutral';
    findings.push({
      id: `metric:${m.name}`, kind: 'metric', severity: 'soft', evidence, direction,
      title: change === null ? `${m.label} ${fmtMetric(m.unit, sb.mean)} → ${fmtMetric(m.unit, sc.mean)}` : `${m.label} ${pct(change)}`,
      detail:
        `${fmtMetric(m.unit, sb.mean)} → ${fmtMetric(m.unit, sc.mean)} (mean of ${vb.length} vs ${vc.length} runs)${fmtP(p)}` +
        (evidence === 'weak' ? '. Not distinguishable from run-to-run noise at this sample size.' : '.'),
      ...(p !== null ? { p } : {}),
    });
  }

  // ---- notes ----------------------------------------------------------------
  if (Math.min(nB, nC) < minRuns) {
    notes.push(
      `With ${Math.min(nB, nC)} run(s) per side, no result can reach p < ${alpha}. Use --runs ${minRuns} or more to confirm findings.`,
    );
  }
  if (baseline.some((t) => t.humanTurns > 1) || candidate.some((t) => t.humanTurns > 1)) {
    notes.push('Some sessions had follow-up human turns; only the first task is comparable.');
  }
  if (metrics.every((m) => m.name !== 'costUsd')) notes.push('Cost unavailable: model not in the price table.');

  const verdict = decideVerdict(findings);
  return {
    schemaVersion: 1,
    baseline: groupInfo(labelOf(baseline, 'baseline'), baseline),
    candidate: groupInfo(labelOf(candidate, 'candidate'), candidate),
    verdict,
    findings: sortFindings(findings),
    metrics,
    files,
    sequence,
    alpha,
    minRunsForSignificance: minRuns,
    notes,
  };
}

/** Convenience wrapper for two single runs. */
export function diffTraces(a: Trace, b: Trace, options?: DiffOptions): DiffReport {
  return diffGroups([a], [b], options);
}

export function decideVerdict(findings: Finding[]): Verdict {
  const adverse = findings.filter((f) => f.direction !== 'better');
  const has = (sev: Finding['severity'], ev: Evidence) => adverse.some((f) => f.severity === sev && f.evidence === ev);
  if (has('hard', 'strong')) return 'regression';
  if (has('hard', 'weak')) return 'likely-regression';
  if (has('soft', 'strong')) return 'drift';
  if (has('soft', 'weak')) return 'possible-drift';
  return 'no-change';
}

function sortFindings(findings: Finding[]): Finding[] {
  const rank = (f: Finding) =>
    (f.severity === 'hard' ? 0 : 4) + (f.evidence === 'strong' ? 0 : 2) + (f.direction === 'better' ? 1 : 0);
  return [...findings].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

/** Process exit code for CI: 0 pass, 1 regression found. (2/3 are reserved for usage/runtime errors.) */
export function exitCodeFor(verdict: Verdict, failOn: 'regression' | 'drift' = 'regression'): 0 | 1 {
  if (verdict === 'regression' || verdict === 'likely-regression') return 1;
  if (failOn === 'drift' && (verdict === 'drift' || verdict === 'possible-drift')) return 1;
  return 0;
}
