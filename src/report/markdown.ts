import type { DiffReport } from '../diff/types.js';
import { fmtMetric, pct } from '../util/format.js';
import { VERDICT_BLURB, VERDICT_LABEL } from './terminal.js';

/** Hidden marker so the GitHub Action can find and update its own PR comment. */
export const COMMENT_MARKER = '<!-- idriftcheckco-report -->';

const EMOJI = {
  regression: '🔴',
  'likely-regression': '🔴',
  drift: '🟡',
  'possible-drift': '🟡',
  'no-change': '🟢',
} as const;

/** Markdown summary for PR comments and CI step summaries. */
export function renderMarkdown(report: DiffReport, opts: { reportUrl?: string } = {}): string {
  const lines: string[] = [COMMENT_MARKER];
  lines.push(`### ${EMOJI[report.verdict]} idriftcheckco: ${VERDICT_LABEL[report.verdict]}`);
  lines.push('');
  lines.push(`${VERDICT_BLURB[report.verdict]}`);
  lines.push('');
  lines.push(
    `**${report.baseline.label}** (${report.baseline.n} run${report.baseline.n === 1 ? '' : 's'}) → ` +
      `**${report.candidate.label}** (${report.candidate.n} run${report.candidate.n === 1 ? '' : 's'})`,
  );
  lines.push('');

  const hard = report.findings.filter((f) => f.severity === 'hard');
  const soft = report.findings.filter((f) => f.severity === 'soft');
  if (hard.length > 0) {
    lines.push('**Hard regressions**');
    for (const f of hard) lines.push(`- ✖ **${f.title}**${f.evidence === 'weak' ? ' _(unconfirmed)_' : ''}: ${f.detail}`);
    lines.push('');
  }
  if (soft.length > 0) {
    lines.push('**Soft drift**');
    for (const f of soft) {
      const icon = f.kind === 'verification-dropped' ? '⚠' : f.direction === 'better' ? '▼' : f.direction === 'worse' ? '▲' : '●';
      lines.push(`- ${icon} **${f.title}**${f.evidence === 'weak' ? ' _(unconfirmed)_' : ''}: ${f.detail}`);
    }
    lines.push('');
  }
  if (report.metrics.length > 0) {
    lines.push('| Metric | Baseline | Candidate | Change | p |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const m of report.metrics) {
      lines.push(
        `| ${m.label} | ${fmtMetric(m.unit, m.baseline.mean)} | ${fmtMetric(m.unit, m.candidate.mean)} | ${m.change === null ? 'n/a' : pct(m.change)} | ${m.p === null ? '' : m.p.toFixed(3)} |`,
      );
    }
    lines.push('');
  }
  for (const n of report.notes) lines.push(`> ${n}`);
  if (opts.reportUrl) lines.push('', `[Full report](${opts.reportUrl})`);
  return lines.join('\n').trimEnd() + '\n';
}
