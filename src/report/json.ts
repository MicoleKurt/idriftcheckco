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
  const map = {
    regression: ['regression', 'red'],
    'likely-regression': ['likely regression', 'red'],
    drift: ['drift', 'yellow'],
    'possible-drift': ['possible drift', 'yellow'],
    'no-change': ['stable', 'brightgreen'],
  } as const;
  const [message, color] = map[report.verdict];
  return { schemaVersion: 1, label: 'agent drift', message, color };
}
