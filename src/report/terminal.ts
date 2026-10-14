import type { DiffReport, Finding, MetricComparison, Verdict } from '../diff/types.js';
import { fmtMetric, pct, stripAnsi } from '../util/format.js';

export interface TerminalOptions {
  color?: boolean;
  /** Use ASCII glyphs (for terminals that mangle Unicode). */
  ascii?: boolean;
  width?: number;
}

const CODES = { reset: 0, bold: 1, dim: 2, red: 31, green: 32, yellow: 33, cyan: 36, gray: 90 } as const;
type Style = keyof typeof CODES;

function painter(enabled: boolean) {
  return (text: string, ...styles: Style[]): string =>
    enabled && styles.length > 0
      ? `\u001b[${styles.map((s) => CODES[s]).join(';')}m${text}\u001b[${CODES.reset}m`
      : text;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  regression: 'REGRESSION',
  'likely-regression': 'LIKELY REGRESSION',
  drift: 'DRIFT',
  'possible-drift': 'POSSIBLE DRIFT',
  'no-change': 'NO CHANGE',
};

export const VERDICT_BLURB: Record<Verdict, string> = {
  regression: 'The candidate behaves measurably worse. Do not ship without a look.',
  'likely-regression': 'Large hard difference, but too few runs to confirm it statistically.',
  drift: 'Behavior changed in ways that cost time or money, though outputs match.',
  'possible-drift': 'Soft differences appeared, but they may be run-to-run noise.',
  'no-change': 'No difference beyond normal run-to-run variation.',
};

function verdictStyles(v: Verdict): Style[] {
  switch (v) {
    case 'regression':
    case 'likely-regression':
      return ['bold', 'red'];
    case 'drift':
    case 'possible-drift':
      return ['bold', 'yellow'];
    default:
      return ['bold', 'green'];
  }
}

function pad(s: string, width: number, right = false): string {
  const gap = Math.max(0, width - stripAnsi(s).length);
  return right ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (indent + cur + ' ' + w).length > width) {
      lines.push(indent + cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(indent + cur);
  return lines;
}

function metricRow(m: MetricComparison): [string, string, string, string, string] {
  const cell = (s: MetricComparison['baseline']) =>
    `${fmtMetric(m.unit, s.mean)}${s.n > 1 && s.sd > 0 ? ` ±${fmtMetric(m.unit, s.sd)}` : ''}`;
  return [
    m.label,
    cell(m.baseline),
    cell(m.candidate),
    m.change === null ? (m.candidate.mean === m.baseline.mean ? '0%' : 'n/a') : pct(m.change),
    m.p === null ? '' : m.p < 0.001 ? 'p<0.001' : `p=${m.p.toFixed(3)}`,
  ];
}

/** Render a DiffReport for a terminal. Pure: pass `color:false` for stable output. */
export function renderTerminal(report: DiffReport, opts: TerminalOptions = {}): string {
  const c = painter(opts.color ?? false);
  const width = Math.min(opts.width ?? 88, 110);
  const g = opts.ascii
    ? { hard: 'x', soft: '*', up: '^', down: 'v', dot: '-', arrow: '->', warn: '!' }
    : { hard: '✖', soft: '●', up: '▲', down: '▼', dot: '·', arrow: '▸', warn: '⚠' };
  const out: string[] = [];
  const side = (grp: DiffReport['baseline']) =>
    `${grp.label}${grp.models.length ? ` [${grp.models.join(', ')}]` : ''} (${grp.n} run${grp.n === 1 ? '' : 's'})`;

  out.push('');
  out.push(` ${c('idriftcheckco', 'bold')}  ${side(report.baseline)} ${c(g.arrow, 'gray')} ${side(report.candidate)}`);
  out.push('');
  out.push(` ${c(` ${VERDICT_LABEL[report.verdict]} `, ...verdictStyles(report.verdict))}  ${VERDICT_BLURB[report.verdict]}`);
  out.push('');

  const section = (title: string, sub: string, items: Finding[]) => {
    if (items.length === 0) return;
    out.push(` ${c(title, 'bold')} ${c(sub, 'gray')}`);
    for (const f of items) {
      const glyph =
        f.severity === 'hard'
          ? c(g.hard, f.evidence === 'strong' ? 'red' : 'yellow')
          : f.kind === 'verification-dropped'
            ? c(g.warn, 'yellow')
            : f.direction === 'better'
              ? c(g.down, 'green')
              : f.direction === 'worse'
                ? c(g.up, 'yellow')
                : c(g.soft, 'cyan');
      const tag = f.evidence === 'weak' ? c(' unconfirmed', 'gray') : '';
      out.push(`  ${glyph} ${c(f.title, 'bold')}${tag}`);
      for (const line of wrap(f.detail, width, '      ')) out.push(c(line, 'gray'));
    }
    out.push('');
  };
  section('HARD', 'what the agent produced', report.findings.filter((f) => f.severity === 'hard'));
  section('SOFT', 'how it got there', report.findings.filter((f) => f.severity === 'soft'));

  if (report.findings.length === 0) {
    out.push(c('  Nothing to report.', 'gray'));
    out.push('');
  }

  if (report.metrics.length > 0) {
    out.push(` ${c('METRICS', 'bold')} ${c('mean ±sd', 'gray')}`);
    const rows = report.metrics.map(metricRow);
    const w = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => r[i]!.length)));
    for (const r of rows) {
      out.push(
        `  ${pad(r[0], w[0]!)}  ${pad(r[1], w[1]!, true)}  ${c(g.arrow, 'gray')} ${pad(r[2], w[2]!, true)}  ${pad(r[3], w[3]!, true)}  ${c(r[4], 'gray')}`,
      );
    }
    out.push('');
  }

  for (const n of report.notes) out.push(...wrap(`${g.dot} ${n}`, width, '  ').map((l) => c(l, 'gray')));
  if (report.notes.length > 0) out.push('');
  return out.join('\n');
}

/** One-line summary, used by CI logs and the `scan` command. */
export function summaryLine(report: DiffReport): string {
  const hard = report.findings.filter((f) => f.severity === 'hard').length;
  const soft = report.findings.filter((f) => f.severity === 'soft').length;
  return `${VERDICT_LABEL[report.verdict]}: ${hard} hard, ${soft} soft finding${soft === 1 ? '' : 's'} (${report.baseline.n} vs ${report.candidate.n} runs)`;
}
