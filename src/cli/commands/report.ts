import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../../config.js';
import { renderHtml } from '../../report/html.js';
import { Store } from '../../store/store.js';
import { parse, type Ctx } from '../context.js';
import { diffRun } from './diff.js';

export const REPORT_HELP = `idriftcheckco report [runId]

Render the self-contained HTML report for a stored replay run (default: latest).
The file has no scripts and makes no network requests, so it is safe to attach to a
PR or send to a teammate.

Options
  --out <file>   Write here instead of .idriftcheckco/reports/<runId>.html
`;

export async function reportCommand(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { options: { out: { type: 'string' }, help: { type: 'boolean' } } }, 'report');
  if (values.help) {
    ctx.stdout(REPORT_HELP);
    return 0;
  }
  const { config } = await loadConfig(ctx.cwd);
  const store = new Store(ctx.cwd, config.storeDir);
  const { report, baseline, candidate, runId } = await diffRun(store, positionals[0] ?? 'latest', config);
  const html = renderHtml(report, { baseline, candidate, generatedAt: new Date().toISOString() });
  let path: string;
  if (values.out) {
    path = resolve(ctx.cwd, values.out);
    await writeFile(path, html, 'utf8');
  } else path = await store.writeReport(runId, html);
  ctx.stdout(path);
  ctx.stderr(`Open: file:///${path.replace(/\\/g, '/')}`);
  return 0;
}
