import { alignMilestones } from '../diff/milestones.js';
import type { DiffReport, Finding, MetricComparison, Verdict } from '../diff/types.js';
import { totalTokens } from '../trace/pricing.js';
import { toolCalls, type Trace } from '../trace/schema.js';
import { VERSION } from '../version.js';
import { escapeHtml as esc, fmtMetric, pct } from '../util/format.js';
import { VERDICT_BLURB, VERDICT_LABEL } from './terminal.js';

export interface HtmlOptions {
  baseline: Trace[];
  candidate: Trace[];
  /** ISO timestamp shown in the footer; injected so output is deterministic in tests. */
  generatedAt?: string;
  title?: string;
}

const CSS = `
:root{
  --bg:#f6f7f9;--card:#fff;--ink:#14171c;--mute:#5d6673;--line:#e3e6ea;
  --base:#4f7cff;--cand:#f08a24;--red:#d6303a;--amber:#b7791f;--green:#1f9d55;--cyan:#0e7490;
  --accent:var(--green);--accent-bg:#e8f6ee;--shadow:0 1px 2px rgba(16,24,40,.06),0 8px 24px rgba(16,24,40,.06);
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0d1014;--card:#151a20;--ink:#e8ecf1;--mute:#93a0b0;--line:#252d37;
  --base:#7b9cff;--cand:#ffa84a;--red:#ff6b73;--amber:#f0b44c;--green:#4cd08a;--cyan:#5cc8e0;
  --accent-bg:#17222b;--shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px rgba(0,0,0,.35);
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:980px;margin:0 auto;padding:32px 20px 64px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
header.top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:20px;color:var(--mute);font-size:13px}
.brand{font-weight:700;letter-spacing:-.01em;color:var(--ink);font-size:15px}
.brand i{font-style:normal;color:var(--cand)}
.hero{background:var(--card);border-radius:16px;box-shadow:var(--shadow);padding:28px 28px 24px;border-left:6px solid var(--accent);position:relative;overflow:hidden}
.hero:after{content:"";position:absolute;inset:0;background:linear-gradient(120deg,var(--accent-bg),transparent 55%);opacity:.7;pointer-events:none}
.hero>*{position:relative;z-index:1}
.pill{display:inline-block;font-weight:800;letter-spacing:.08em;font-size:12px;padding:4px 10px;border-radius:999px;color:#fff;background:var(--accent)}
.hero h1{margin:12px 0 6px;font-size:30px;line-height:1.2;letter-spacing:-.02em}
.hero p{margin:0;color:var(--mute);max-width:62ch}
.arms{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.arm{display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:10px;background:var(--bg);border:1px solid var(--line);font-size:13px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.dot.b{background:var(--base)}.dot.c{background:var(--cand)}
.arrow{align-self:center;color:var(--mute)}
.v-regression,.v-likely-regression{--accent:var(--red);--accent-bg:rgba(214,48,58,.10)}
.v-drift,.v-possible-drift{--accent:var(--amber);--accent-bg:rgba(183,121,31,.12)}
.v-no-change{--accent:var(--green);--accent-bg:rgba(31,157,85,.10)}
section{margin-top:28px}
h2{font-size:13px;letter-spacing:.09em;text-transform:uppercase;color:var(--mute);margin:0 0 10px;font-weight:700}
h2 small{text-transform:none;letter-spacing:0;font-weight:400;margin-left:6px}
.card{background:var(--card);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}
.finding{display:flex;gap:14px;padding:14px 18px;border-top:1px solid var(--line)}
.finding:first-child{border-top:0}
.ico{flex:none;width:26px;height:26px;border-radius:8px;display:grid;place-items:center;font-weight:800;font-size:14px;color:#fff;margin-top:1px}
.ico.hard{background:var(--red)}.ico.hard.weak{background:var(--amber)}
.ico.warn{background:var(--amber)}.ico.up{background:var(--amber)}.ico.down{background:var(--green)}.ico.neutral{background:var(--cyan)}
.finding h3{margin:0;font-size:15px}
.finding p{margin:2px 0 0;color:var(--mute);font-size:13.5px}
.tag{font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--mute);margin-left:8px;vertical-align:1px}
.tag.weak{color:var(--amber);border-color:var(--amber)}
.empty{padding:18px;color:var(--mute)}
.metric{display:grid;grid-template-columns:130px 1fr 150px;gap:14px;align-items:center;padding:12px 18px;border-top:1px solid var(--line)}
.metric:first-child{border-top:0}
.metric .name{font-weight:600}
.metric .vals{font-size:12.5px;color:var(--mute)}
.metric .chg{text-align:right;font-variant-numeric:tabular-nums}
.chg b{font-size:16px}.chg small{display:block;color:var(--mute)}
.up-c{color:var(--amber)}.down-c{color:var(--green)}
svg.strip{width:100%;height:46px;display:block}
.axis{stroke:var(--line);stroke-width:1}
.tick-b{stroke:var(--base);stroke-width:2}.tick-c{stroke:var(--cand);stroke-width:2}
.pt-b{fill:var(--base);fill-opacity:.8}.pt-c{fill:var(--cand);fill-opacity:.8}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);text-align:left;padding:10px 18px;font-weight:700}
td{padding:9px 18px;border-top:1px solid var(--line);vertical-align:middle}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.bar{display:inline-block;height:8px;border-radius:4px;vertical-align:middle;min-width:2px}
.bar.b{background:var(--base)}.bar.c{background:var(--cand)}
.rate{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--mute)}
.tl{display:grid;grid-template-columns:1fr 1fr;gap:0}
.tl .h{padding:10px 18px;font-size:12px;font-weight:700;color:var(--mute);text-transform:uppercase;letter-spacing:.06em;display:flex;gap:8px;align-items:center}
.tl .cell{padding:5px 18px;border-top:1px dashed var(--line);min-height:34px;display:flex;align-items:center}
.chip{display:inline-block;padding:3px 9px;border-radius:7px;border:1px solid var(--line);font-size:12.5px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip.same{background:var(--bg)}
.chip.removed{background:rgba(214,48,58,.12);border-color:var(--red);color:var(--red);text-decoration:line-through}
.chip.added{background:rgba(79,124,255,.12);border-color:var(--base)}
details{margin-top:10px}
summary{cursor:pointer;color:var(--mute);font-size:13px;padding:6px 0}
.note{margin:6px 0;color:var(--mute);font-size:13px}
footer{margin-top:36px;color:var(--mute);font-size:12.5px;border-top:1px solid var(--line);padding-top:16px}
footer p{margin:6px 0}
@media (max-width:700px){.metric{grid-template-columns:1fr}.metric .chg{text-align:left}.tl{grid-template-columns:1fr}.hero h1{font-size:24px}}
@media print{body{background:#fff}.card,.hero{box-shadow:none;border:1px solid var(--line)}}
`;

function glyph(f: Finding): { cls: string; ch: string } {
  if (f.severity === 'hard') return { cls: `hard ${f.evidence === 'weak' ? 'weak' : ''}`, ch: '✖' };
  if (f.kind === 'verification-dropped') return { cls: 'warn', ch: '!' };
  if (f.direction === 'better') return { cls: 'down', ch: '▼' };
  if (f.direction === 'worse') return { cls: 'up', ch: '▲' };
  return { cls: 'neutral', ch: '●' };
}

function findingHtml(f: Finding): string {
  const g = glyph(f);
  return `<div class="finding"><div class="ico ${g.cls}">${g.ch}</div><div><h3>${esc(f.title)}${
    f.evidence === 'weak' ? '<span class="tag weak">unconfirmed</span>' : '<span class="tag">confirmed</span>'
  }</h3><p>${esc(f.detail)}</p></div></div>`;
}

function stripPlot(m: MetricComparison): string {
  const W = 420;
  const pad = 14;
  const all = [...m.values.baseline, ...m.values.candidate];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (lo === hi) {
    lo -= Math.abs(lo) * 0.1 || 1;
    hi += Math.abs(hi) * 0.1 || 1;
  }
  const x = (v: number) => (pad + ((v - lo) / (hi - lo)) * (W - 2 * pad)).toFixed(1);
  const dots = (vals: number[], y: number, cls: string, label: string) =>
    vals
      .map((v) => `<circle class="${cls}" cx="${x(v)}" cy="${y}" r="5"><title>${esc(label)}: ${esc(fmtMetric(m.unit, v))}</title></circle>`)
      .join('');
  const tick = (mean: number, y: number, cls: string) =>
    `<line class="${cls}" x1="${x(mean)}" x2="${x(mean)}" y1="${y - 9}" y2="${y + 9}"/>`;
  return (
    `<svg class="strip" viewBox="0 0 ${W} 46" role="img" aria-label="${esc(m.label)} distribution">` +
    `<line class="axis" x1="${pad}" x2="${W - pad}" y1="23" y2="23"/>` +
    tick(m.baseline.mean, 14, 'tick-b') +
    tick(m.candidate.mean, 34, 'tick-c') +
    dots(m.values.baseline, 14, 'pt-b', 'baseline') +
    dots(m.values.candidate, 34, 'pt-c', 'candidate') +
    `</svg>`
  );
}

function metricHtml(m: MetricComparison): string {
  const worse = m.change !== null && m.change > 0;
  const cls = m.change === null || Math.abs(m.change) < 0.05 ? '' : worse ? 'up-c' : 'down-c';
  const cell = (s: MetricComparison['baseline']) =>
    `${fmtMetric(m.unit, s.mean)}${s.n > 1 && s.sd > 0 ? ` ±${fmtMetric(m.unit, s.sd)}` : ''}`;
  return `<div class="metric"><div><div class="name">${esc(m.label)}</div><div class="vals"><span class="dot b"></span> ${esc(cell(m.baseline))}<br><span class="dot c"></span> ${esc(cell(m.candidate))}</div></div>${stripPlot(m)}<div class="chg ${cls}"><b>${
    m.change === null ? (m.candidate.mean === m.baseline.mean ? '0%' : 'n/a') : esc(pct(m.change))
  }</b><small>${m.p === null ? '' : m.p < 0.001 ? 'p &lt; 0.001' : `p = ${m.p.toFixed(3)}`}</small></div></div>`;
}

function pretty(m: string): string {
  const [kind, ...rest] = m.split(':');
  const v = rest.join(':');
  switch (kind) {
    case 'exec':
      return `$ ${v}`;
    case 'write':
      return `✎ ${v}`;
    case 'mcp':
      return `⚙ ${v.replace(/^mcp__/, '')}`;
    case 'agent':
      return `◆ ${v}`;
    default:
      return m;
  }
}

function timelineHtml(report: DiffReport): string {
  const ops = alignMilestones(report.sequence.baselineMilestones, report.sequence.candidateMilestones);
  if (ops.length === 0) return `<div class="empty">No edits, commands or tool calls to align.</div>`;
  const chip = (op: string, v: string) => `<span class="chip ${op}" title="${esc(v)}">${esc(pretty(v))}</span>`;
  const cells = ops
    .map((o) => {
      const left = o.op === 'added' ? '' : chip(o.op === 'same' ? 'same' : 'removed', o.value);
      const right = o.op === 'removed' ? '' : chip(o.op === 'same' ? 'same' : 'added', o.value);
      return `<div class="cell">${left}</div><div class="cell">${right}</div>`;
    })
    .join('');
  return `<div class="tl"><div class="h"><span class="dot b"></span>${esc(report.baseline.label)} · first run</div><div class="h"><span class="dot c"></span>${esc(report.candidate.label)} · first run</div>${cells}</div>`;
}

function filesHtml(report: DiffReport): string {
  if (report.files.length === 0) return `<div class="empty">Neither side changed any files.</div>`;
  const bar = (r: number, cls: string) => `<span class="bar ${cls}" style="width:${Math.round(r * 90)}px"></span>`;
  const rows = report.files
    .map(
      (f) =>
        `<tr><td class="mono">${esc(f.path)}</td><td><div class="rate">${bar(f.baselineRate, 'b')}${Math.round(f.baselineRate * 100)}%</div></td><td><div class="rate">${bar(f.candidateRate, 'c')}${Math.round(f.candidateRate * 100)}%</div></td><td class="num">${f.p === null ? '' : f.p.toFixed(3)}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>File</th><th>Baseline changes it</th><th>Candidate changes it</th><th class="num">p</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function runsHtml(label: string, cls: string, traces: Trace[]): string {
  const rows = traces
    .map((t) => {
      const calls = toolCalls(t);
      return `<tr><td class="mono">${esc(t.id)}</td><td>${esc(t.outcome.status)}${
        t.outcome.check ? ` · check ${t.outcome.check.exitCode === 0 ? 'passed' : 'failed'}` : ''
      }</td><td class="num">${calls.length}</td><td class="num">${calls.filter((c) => !c.ok).length}</td><td class="num">${
        t.costUsd === null ? 'n/a' : esc(fmtMetric('usd', t.costUsd))
      }</td><td class="num">${esc(fmtMetric('tokens', totalTokens(t.usage)))}</td><td class="num">${t.filesChanged.length}</td></tr>`;
    })
    .join('');
  return `<details><summary><span class="dot ${cls}"></span> ${esc(label)}: ${traces.length} run${traces.length === 1 ? '' : 's'}</summary><div class="card"><table><thead><tr><th>Run</th><th>Outcome</th><th class="num">Tools</th><th class="num">Errors</th><th class="num">Cost</th><th class="num">Tokens</th><th class="num">Files</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function headline(report: DiffReport): string {
  const hard = report.findings.filter((f) => f.severity === 'hard' && f.direction !== 'better');
  const soft = report.findings.filter((f) => f.severity === 'soft' && f.direction !== 'better');
  const v: Verdict = report.verdict;
  if (v === 'no-change') return 'No behavioral difference beyond normal variation';
  if (hard.length > 0) return `${hard[0]!.title}${hard.length > 1 ? ` and ${hard.length - 1} more hard difference${hard.length > 2 ? 's' : ''}` : ''}`;
  return `${soft[0]!.title}${soft.length > 1 ? ` and ${soft.length - 1} more` : ''}`;
}

/** Render a single-file, dependency-free HTML report (no scripts, no network). */
export function renderHtml(report: DiffReport, opts: HtmlOptions): string {
  const hard = report.findings.filter((f) => f.severity === 'hard');
  const soft = report.findings.filter((f) => f.severity === 'soft');
  const arm = (g: DiffReport['baseline'], cls: string) =>
    `<span class="arm"><span class="dot ${cls}"></span><b>${esc(g.label)}</b>${g.models.length ? ` <span class="mono">${esc(g.models.join(', '))}</span>` : ''} · ${g.n} run${g.n === 1 ? '' : 's'}</span>`;
  const title = opts.title ?? `idriftcheckco: ${report.baseline.label} vs ${report.candidate.label}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="color-scheme" content="light dark">
<style>${CSS}</style></head>
<body><div class="wrap v-${report.verdict}">
<header class="top"><span class="brand">idrift<i>check</i>co</span><span>behavior diff report</span></header>
<div class="hero">
  <span class="pill">${esc(VERDICT_LABEL[report.verdict])}</span>
  <h1>${esc(headline(report))}</h1>
  <p>${esc(VERDICT_BLURB[report.verdict])}</p>
  <div class="arms">${arm(report.baseline, 'b')}<span class="arrow">→</span>${arm(report.candidate, 'c')}</div>
</div>

<section><h2>Hard differences <small>what the agent produced</small></h2><div class="card">${
    hard.length ? hard.map(findingHtml).join('') : '<div class="empty">None: same files, same completion, same checks.</div>'
  }</div></section>

<section><h2>Soft drift <small>how it got there</small></h2><div class="card">${
    soft.length ? soft.map(findingHtml).join('') : '<div class="empty">None above the noise threshold.</div>'
  }</div></section>

<section><h2>Metrics <small><span class="dot b"></span> baseline <span class="dot c"></span> candidate · each dot is one run</small></h2><div class="card">${
    report.metrics.length ? report.metrics.map(metricHtml).join('') : '<div class="empty">No comparable metrics.</div>'
  }</div></section>

<section><h2>Order of work <small>edits, commands and tool calls; reads are ignored</small></h2><div class="card">${timelineHtml(report)}</div>${
    report.sequence.within !== null
      ? `<p class="note">Similarity between baseline runs: ${Math.round(report.sequence.within * 100)}% (noise floor). Baseline vs candidate: ${Math.round(report.sequence.across * 100)}%.</p>`
      : `<p class="note">Baseline vs candidate similarity: ${Math.round(report.sequence.across * 100)}%.</p>`
  }</section>

<section><h2>Files changed</h2><div class="card">${filesHtml(report)}</div></section>

<section><h2>Runs</h2>${runsHtml(report.baseline.label, 'b', opts.baseline)}${runsHtml(report.candidate.label, 'c', opts.candidate)}</section>

<footer>
${report.notes.map((n) => `<p>${esc(n)}</p>`).join('')}
<p><b>Method.</b> Exact permutation tests for numeric metrics and Fisher&rsquo;s exact test for proportions, α = ${report.alpha}. A finding marked <i>unconfirmed</i> is a large effect that cannot reach significance with this many runs (at least ${report.minRunsForSignificance} per side are needed). &ldquo;Completed&rdquo; means the agent stopped on its own, not that its work is correct.</p>
<p>Generated by idriftcheckco ${esc(VERSION)}${opts.generatedAt ? ` on ${esc(opts.generatedAt)}` : ''}. Secrets and home-directory paths were redacted at import; review before sharing publicly. This file makes no network requests.</p>
</footer>
</div></body></html>
`;
}
