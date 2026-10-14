import { existsSync } from 'node:fs';
import { listSessionFiles, loadSession, sessionsRoot, type SessionFile } from '../../adapters/discover.js';
import { parseClaudeCodeSession } from '../../adapters/claude-code.js';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadConfig, type Config } from '../../config.js';
import { scanSessions } from '../../scan.js';
import { Store } from '../../store/store.js';
import type { Trace } from '../../trace/schema.js';
import { num, parse, UsageError, type Ctx } from '../context.js';

export const IMPORT_HELP = `idriftcheckco import [session...]

Copy sessions into .idriftcheckco/traces/ as redacted, git-friendly JSON, so they
survive transcript cleanup and can be replayed. Arguments are session ids (any
unique prefix, as shown by \`scan\`) or paths to .jsonl files. With no arguments,
imports the best-ranked sessions.

Options
  --top <n>         With no arguments, import the n best sessions (default 3)
  --all             Search every project when resolving ids
  --sessions <dir>  Agent config directory holding projects/
`;

async function resolveSession(ref: string, root: string, project: string | undefined): Promise<SessionFile> {
  if (ref.endsWith('.jsonl') && existsSync(ref)) {
    return { path: ref, project: '', sessionId: basename(ref, '.jsonl'), bytes: 0, mtimeMs: 0 };
  }
  const scoped = await listSessionFiles(root, project);
  let hits = scoped.filter((f) => f.sessionId.startsWith(ref));
  if (hits.length === 0) hits = (await listSessionFiles(root)).filter((f) => f.sessionId.startsWith(ref));
  if (hits.length === 0) throw new UsageError(`No session matches "${ref}". Run \`idriftcheckco scan\` to list session ids.`);
  if (hits.length > 1) throw new UsageError(`"${ref}" matches ${hits.length} sessions. Use more characters of the id.`);
  return hits[0]!;
}

/**
 * Resolve a trace for `replay`: a stored trace first, otherwise import the matching
 * session on the fly so a first-time user does not need a separate `import` step.
 */
export async function resolveSourceTrace(ctx: Ctx, config: Config, store: Store, ref: string): Promise<Trace> {
  try {
    return await store.resolveTrace(ref);
  } catch (notStored) {
    const root = sessionsRoot(config.sessionsDir, ctx.env);
    let file: SessionFile;
    try {
      file = await resolveSession(ref, root, ctx.cwd);
    } catch {
      throw notStored;
    }
    const trace =
      file.project === ''
        ? parseClaudeCodeSession(await readFile(file.path, 'utf8'), { sessionId: file.sessionId })
        : await loadSession(file, config.prices);
    await store.saveTrace(trace);
    ctx.stderr(`Imported session ${trace.id.slice(0, 8)} into ${store.tracesDir}`);
    return trace;
  }
}

export async function importCommand(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    options: { top: { type: 'string' }, all: { type: 'boolean' }, sessions: { type: 'string' }, help: { type: 'boolean' } },
  }, 'import');
  if (values.help) {
    ctx.stdout(IMPORT_HELP);
    return 0;
  }
  const { config } = await loadConfig(ctx.cwd);
  const root = sessionsRoot(values.sessions ?? config.sessionsDir, ctx.env);
  const store = new Store(ctx.cwd, config.storeDir);
  const project = values.all ? undefined : ctx.cwd;
  const traces: Trace[] = [];

  if (positionals.length > 0) {
    for (const ref of positionals) {
      const file = await resolveSession(ref, root, project);
      traces.push(file.project === '' ? parseClaudeCodeSession(await readFile(file.path, 'utf8'), { sessionId: file.sessionId }) : await loadSession(file, config.prices));
    }
  } else {
    const top = num(values.top, 'top', 1) ?? 3;
    let found = await scanSessions({ root, ...(project ? { project } : {}), limit: 40 });
    if (found.entries.length === 0) found = await scanSessions({ root, limit: 40 });
    if (found.entries.length === 0) throw new UsageError('No sessions found to import. Run your agent on a task first, or pass --sessions <dir>.');
    traces.push(...found.entries.sort((a, b) => b.rank.score - a.rank.score).slice(0, top).map((e) => e.trace));
  }

  for (const t of traces) {
    const path = await store.saveTrace(t);
    ctx.stdout(`imported ${t.id.slice(0, 8)}  ${t.task.replace(/\s+/g, ' ').slice(0, 70)}`);
    ctx.stdout(`         → ${path}`);
  }
  ctx.stdout(`\nSecrets and home-directory paths were redacted. Next: idriftcheckco replay ${traces[0]!.id.slice(0, 8)} --model <model> --dry-run`);
  return 0;
}
