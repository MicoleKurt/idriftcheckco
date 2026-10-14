/**
 * Render the README hero: an animated terminal SVG of the REAL `idriftcheckco demo`
 * output (captured with colors, converted from ANSI). Run: pnpm exec tsx scripts/render-demo-svg.ts
 * Output: docs/assets/demo.svg. No dependencies; CSS animation only, so GitHub renders it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ctx } from '../src/cli/context.js';
import { runDemo } from '../src/demo.js';
import { renderTerminal } from '../src/report/terminal.js';

const FG = '#e6edf3';
const COLORS: Record<number, string> = { 31: '#ff7b72', 32: '#3fb950', 33: '#e3b341', 36: '#56d4dd', 90: '#8b949e' };
const FONT = 13;
const LINE = 18;
const CHAR = FONT * 0.6;
const PAD_X = 22;
const TOP = 52;

interface Span { text: string; color: string; bold: boolean }

/** Split one line of ANSI-colored text into styled spans. */
function parseAnsi(line: string): Span[] {
  const spans: Span[] = [];
  let color = FG;
  let bold = false;
  // eslint-disable-next-line no-control-regex
  const re = /\u001b\[([0-9;]*)m/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (t: string) => t && spans.push({ text: t, color, bold });
  while ((m = re.exec(line))) {
    push(line.slice(last, m.index));
    for (const code of m[1]!.split(';').map(Number)) {
      if (code === 0) {
        color = FG;
        bold = false;
      } else if (code === 1) bold = true;
      else if (COLORS[code]) color = COLORS[code]!;
    }
    last = re.lastIndex;
  }
  push(line.slice(last));
  return spans;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'idc-svg-'));
  const ctx: Ctx = {
    cwd: dir, env: {}, stdout: () => undefined, stderr: () => undefined,
    color: true, interactive: false, confirm: async () => false,
  };
  const { report } = await runDemo(ctx, join(dir, 'r.html'));
  rmSync(dir, { recursive: true, force: true });

  const all = renderTerminal(report, { color: true, width: 84 }).split('\n');
  // Keep the story: header, verdict, findings, metrics. Drop trailing notes/blank lines.
  const end = all.findIndex((l, i) => i > 5 && l.includes('METRICS'));
  const lines = all.slice(0, end > 0 ? end + 6 : all.length);
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();

  const command = '$ npx idriftcheckco demo';
  const cols = Math.max(command.length, ...lines.map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').length));
  const width = Math.ceil(PAD_X * 2 + cols * CHAR);
  const height = TOP + (lines.length + 2) * LINE + 18;
  const typeStep = 0.045;
  const outputStart = 0.4 + command.length * typeStep + 0.5;

  const typed = [...command]
    .map((ch, i) => `<tspan class="a" style="animation-delay:${(0.4 + i * typeStep).toFixed(2)}s">${esc(ch)}</tspan>`)
    .join('');
  const BADGE = new Set([COLORS[31], COLORS[32], COLORS[33]]);
  const body = lines
    .map((line, i) => {
      const y = TOP + (i + 2) * LINE;
      const delay = `animation-delay:${(outputStart + i * 0.07).toFixed(2)}s`;
      const parsed = parseAnsi(line);
      // The verdict line's bold colored label becomes a solid badge, as in the HTML report.
      let badge = '';
      if (/REGRESSION|DRIFT|NO CHANGE/.test(line) && i < 6) {
        let col = 0;
        for (const s of parsed) {
          if (s.bold && BADGE.has(s.color) && !badge) {
            badge = `<rect class="a" style="${delay}" x="${(PAD_X + col * CHAR - 1).toFixed(1)}" y="${y - FONT + 1}" width="${(s.text.length * CHAR + 2).toFixed(1)}" height="${LINE - 1}" rx="4" fill="${s.color}"/>`;
            s.color = '#0d1117';
          }
          col += s.text.length;
        }
      }
      const spans = parsed
        .map((s) => `<tspan fill="${s.color}"${s.bold ? ' font-weight="700"' : ''}>${esc(s.text)}</tspan>`)
        .join('');
      return `${badge}<text class="a" x="${PAD_X}" y="${y}" style="${delay}">${spans}</text>`;
    })
    .join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Terminal running npx idriftcheckco demo and reporting a regression">
<title>npx idriftcheckco demo</title>
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:${FONT}px;white-space:pre}
.a{opacity:0;animation:show .01s linear forwards}
@keyframes show{to{opacity:1}}
@media (prefers-reduced-motion:reduce){.a{animation:none;opacity:1}}
</style>
<rect width="${width}" height="${height}" rx="10" fill="#0d1117"/>
<rect width="${width}" height="34" rx="10" fill="#161b22"/>
<rect y="24" width="${width}" height="10" fill="#161b22"/>
<circle cx="20" cy="17" r="6" fill="#ff5f56"/><circle cx="40" cy="17" r="6" fill="#ffbd2e"/><circle cx="60" cy="17" r="6" fill="#27c93f"/>
<text x="${width / 2}" y="21" fill="#8b949e" text-anchor="middle" style="font-size:12px">idriftcheckco</text>
<text x="${PAD_X}" y="${TOP + LINE * 0.5}" fill="${FG}" xml:space="preserve">${typed}</text>
${body}
</svg>
`;
  const out = join('docs', 'assets', 'demo.svg');
  writeFileSync(out, svg);
  console.log(`wrote ${out} (${width}x${height}, ${lines.length} lines, ${(svg.length / 1024).toFixed(1)} KB)`);
}

await main();
