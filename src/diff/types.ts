import type { Summary } from './stats.js';

export type Severity = 'hard' | 'soft';

/**
 * `strong`: statistically supported (p < alpha).
 * `weak`: a large effect that cannot be confirmed at this sample size.
 */
export type Evidence = 'strong' | 'weak';

export type FindingKind =
  | 'file-missing'
  | 'file-unexpected'
  | 'completion'
  | 'check'
  | 'verification-dropped'
  | 'milestone'
  | 'sequence'
  | 'metric';

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  evidence: Evidence;
  /** `better` findings are reported but never worsen the verdict. */
  direction: 'worse' | 'better' | 'neutral';
  title: string;
  detail: string;
  /** Exact p-value when a test applied. */
  p?: number;
}

export type Verdict = 'regression' | 'likely-regression' | 'drift' | 'possible-drift' | 'no-change';

export type MetricName = 'toolCalls' | 'costUsd' | 'totalTokens' | 'durationMs' | 'toolErrors';

export interface MetricComparison {
  name: MetricName;
  label: string;
  unit: 'count' | 'usd' | 'tokens' | 'ms';
  baseline: Summary;
  candidate: Summary;
  values: { baseline: number[]; candidate: number[] };
  /** Relative change of the mean, or null when it cannot be computed. */
  change: number | null;
  p: number | null;
}

export interface FileComparison {
  path: string;
  baselineRate: number;
  candidateRate: number;
  p: number | null;
}

export interface GroupInfo {
  label: string;
  n: number;
  models: string[];
  traceIds: string[];
}

export interface SequenceComparison {
  /** Mean similarity between runs of the baseline arm (the noise floor); null if n < 2. */
  within: number | null;
  /** Mean similarity between baseline and candidate runs. */
  across: number;
  baselineMilestones: string[];
  candidateMilestones: string[];
}

export interface DiffReport {
  schemaVersion: 1;
  baseline: GroupInfo;
  candidate: GroupInfo;
  verdict: Verdict;
  findings: Finding[];
  metrics: MetricComparison[];
  files: FileComparison[];
  sequence: SequenceComparison;
  alpha: number;
  /** Smallest runs-per-arm for which a perfectly separated result can reach p < alpha. */
  minRunsForSignificance: number;
  notes: string[];
}

export interface DiffOptions {
  /** Significance level. Default 0.05. */
  alpha?: number;
  /** Minimum relative change of a soft metric to be reported. Default 0.25. */
  softThreshold?: number;
  seed?: number;
}
