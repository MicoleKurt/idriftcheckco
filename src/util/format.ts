export type MetricUnit = 'count' | 'usd' | 'tokens' | 'ms';

/** Human-readable metric value. */
export function fmtMetric(unit: MetricUnit, v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  switch (unit) {
    case 'usd':
      return `$${v.toFixed(v < 1 ? 3 : 2)}`;
    case 'ms':
      return v >= 60_000 ? `${(v / 60_000).toFixed(1)}m` : `${(v / 1000).toFixed(1)}s`;
    case 'tokens':
      return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
    default:
      return Number.isInteger(v) ? `${v}` : v.toFixed(1);
  }
}

/** Signed percentage, e.g. `+25%`. */
export function pct(x: number): string {
  return `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`;
}

/** ` (p=0.029)` or an empty string when no test applied. */
export function fmtP(p: number | null | undefined): string {
  return p === null || p === undefined ? '' : ` (p=${p < 0.001 ? '<0.001' : p.toFixed(3)})`;
}

/** Strip ANSI escape sequences (for width calculations and tests). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
