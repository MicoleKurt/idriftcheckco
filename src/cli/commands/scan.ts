import { sessionsRoot } from '../../adapters/discover.js';
import { loadConfig } from '../../config.js';
import { renderScan, scanSessions, type ScanEntry } from '../../scan.js';
import { num, parse, type Ctx } from '../context.js';

export const SCAN_HELP = `idriftcheckco [scan]

Find your existing agent sessions, rank them by how well they suit replay, and
summarize behavior per model. Free, offline, read-only.

Options
  --project <dir>   Scan sessions for this working directory (default: current)
  --all             Scan every project
  --sessions <dir>  Agent config directory holding projects/ (default: $CLAUDE_CONFIG_DIR or ~/.claude)
  --limit <n>       Parse the newest n sessions (default 40)
  --top <n>         Show n best candidates (default 6)
  --json            Machine-readable output
`;

export async function scanCommand(ctx: Ctx, argv: string[]): Promise<number> {
  const { values } = parse(argv, {
    options: {
      project: { type: 'string' }, all: { type: 'boolean' }, sessions: { type: 'string' },
      limit: { type: 'string' }, top: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
    },
  }, 'scan');
  if (values.help) {
    ctx.stdout(SCAN_HELP);
    return 0;
  }
  const { config } = await loadConfig(ctx.cwd);
  const root = sessionsRoot(values.sessions ?? config.sessionsDir, ctx.env);
  const limit = num(values.limit, 'limit', 1) ?? 40;
  const project = values.all ? undefined : (values.project ?? ctx.cwd);

  let scope = values.all ? 'all projects' : (project ?? 'this folder');
  let result = await scanSessions({ root, ...(project ? { project } : {}), limit, ...(config.prices ? { prices: config.prices } : {}) });
  if (result.entries.length === 0 && project) {
    scope = 'all projects (none found for this folder)';
    result = await scanSessions({ root, limit, ...(config.prices ? { prices: config.prices } : {}) });
  }

  if (values.json) {
    ctx.stdout(JSON.stringify(result.entries.map(toJson), null, 2));
    return 0;
  }
  ctx.stdout(renderScan(result.entries, { totalFiles: result.totalFiles, skipped: result.skipped, scope }, { color: ctx.color, top: num(values.top, 'top', 1) ?? 6 }));
  return 0;
}

function toJson(e: ScanEntry) {
  return {
    sessionId: e.file.sessionId,
    project: e.file.project,
    model: e.trace.model ?? null,
    task: e.trace.task.slice(0, 200),
    replayability: e.rank,
    toolCalls: e.trace.steps.filter((s) => s.tool).length,
    costUsd: e.trace.costUsd,
    status: e.trace.outcome.status,
  };
}
