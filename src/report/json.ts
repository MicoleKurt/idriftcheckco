import { exitCodeFor } from '../diff/diff.js';
import type { DiffReport } from '../diff/types.js';

/** Machine-readable output for CI. Stable: additive changes only within a major version. */
export interface CiResult {
  schemaVersion: 1;
  verdict: DiffReport['verdict'];
  exitCode: 0 | 1;
  failOn: 'regression' | 'drift';
  counts: { hard: number; soft: number };
  report: DiffReport;
}

export function toCiResult(report: DiffReport, failOn: 'regression' | 'drift' = 'regression'): CiResult {
  return {
    schemaVersion: 1,
    verdict: report.verdict,
    exitCode: exitCodeFor(report.verdict, failOn),
    failOn,
    counts: {
      hard: report.findings.filter((f) => f.severity === 'hard').length,
      soft: report.findings.filter((f) => f.severity === 'soft').length,
    },
    report,
  };
}

export function renderJson(report: DiffReport, failOn: 'regression' | 'drift' = 'regression'): string {
  return JSON.stringify(toCiResult(report, failOn), null, 2) + '\n';
}

/** Shields.io "endpoint" payload for a README badge. */
export function badgeEndpoint(report: DiffReport): { schemaVersion: 1; label: string; message: string; color: string } {
  return badgeForVerdict(report.verdict);
}

/** Badge payload for a bare verdict (used for multi-task suites). */
export function badgeForVerdict(verdict: DiffReport['verdict']): { schemaVersion: 1; label: string; message: string; color: string } {
  const map = {
    regression: ['regression', 'red'],
    'likely-regression': ['likely regression', 'red'],
    drift: ['drift', 'yellow'],
    'possible-drift': ['possible drift', 'yellow'],
    'no-change': ['stable', 'brightgreen'],
  } as const;
  const [message, color] = map[verdict];
  return { schemaVersion: 1, label: 'agent drift', message, color };
}

const VERDICT_ORDER: DiffReport['verdict'][] = ['no-change', 'possible-drift', 'drift', 'likely-regression', 'regression'];

/** The most severe verdict among several. */
export function worstVerdict(verdicts: DiffReport['verdict'][]): DiffReport['verdict'] {
  return verdicts.reduce((w, v) => (VERDICT_ORDER.indexOf(v) > VERDICT_ORDER.indexOf(w) ? v : w), 'no-change' as DiffReport['verdict']);
}

export interface SuiteResult {
  schemaVersion: 1;
  verdict: DiffReport['verdict'];
  exitCode: 0 | 1;
  failOn: 'regression' | 'drift';
  tasks: Array<CiResult & { task: string }>;
}

/** Aggregate several per-task reports (one per replayed session) into one CI result. */
export function toSuiteResult(
  items: Array<{ task: string; report: DiffReport }>,
  failOn: 'regression' | 'drift' = 'regression',
): SuiteResult {
  const verdict = worstVerdict(items.map((i) => i.report.verdict));
  return {
    schemaVersion: 1,
    verdict,
    exitCode: exitCodeFor(verdict, failOn),
    failOn,
    tasks: items.map((i) => ({ task: i.task, ...toCiResult(i.report, failOn) })),
  };
}
