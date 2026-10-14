import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listSessionFiles, sessionsRoot } from '../../adapters/discover.js';
import { loadConfig } from '../../config.js';
import type { AgentRunner, Check } from '../../replay/runner.js';
import { renderChecks } from '../checks.js';
import { parse, type Ctx } from '../context.js';
import { makeRunner } from '../run.js';

const execFileAsync = promisify(execFile);

export const DOCTOR_HELP = `idriftcheckco doctor

Check that everything a replay needs is in place, with a fix for anything missing:
Node version, git, a git repository, your session transcripts, the config file, and
that the agent CLI is installed and logged in. Free: makes no model calls.

Exit code 0 when nothing failed, 3 otherwise.
`;

async function gitChecks(cwd: string): Promise<Check[]> {
  try {
    const { stdout } = await execFileAsync('git', ['--version'], { windowsHide: true });
    const checks: Check[] = [{ name: 'git', status: 'ok', detail: stdout.trim() }];
    try {
      await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true });
      checks.push({ name: 'git repository', status: 'ok', detail: 'replays can run here' });
    } catch {
      checks.push({
        name: 'git repository', status: 'warn', detail: 'this folder is not inside a git repository',
        fix: 'Replay needs one (it isolates runs with git worktrees). `scan`, `import` and `diff` work anywhere.',
      });
    }
    return checks;
  } catch {
    return [{ name: 'git', status: 'fail', detail: 'git was not found on PATH', fix: 'Install git: https://git-scm.com/downloads' }];
  }
}

/** All checks, in display order. Injectable runner for tests. */
export async function runDoctor(ctx: Ctx, runner?: AgentRunner): Promise<Check[]> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(
    major >= 20
      ? { name: 'node', status: 'ok', detail: `v${process.versions.node}` }
      : { name: 'node', status: 'fail', detail: `v${process.versions.node} is too old`, fix: 'Install Node.js 20 or newer.' },
  );
  checks.push(...(await gitChecks(ctx.cwd)));

  let config;
  try {
    const loaded = await loadConfig(ctx.cwd);
    config = loaded.config;
    checks.push({ name: 'config', status: 'ok', detail: loaded.path ? `loaded ${loaded.path}` : 'none (zero-config defaults)' });
  } catch (e) {
    checks.push({ name: 'config', status: 'fail', detail: (e as Error).message, fix: 'Fix or delete the config file.' });
  }

  const root = sessionsRoot(config?.sessionsDir, ctx.env);
  const here = await listSessionFiles(root, ctx.cwd);
  const all = here.length > 0 ? here : await listSessionFiles(root);
  if (here.length > 0) checks.push({ name: 'sessions', status: 'ok', detail: `${here.length} for this folder in ${root}` });
  else if (all.length > 0) {
    checks.push({ name: 'sessions', status: 'warn', detail: `none for this folder, ${all.length} in other projects`, fix: 'Use `scan --all`, or run your agent here first.' });
  } else {
    checks.push({ name: 'sessions', status: 'warn', detail: `no transcripts found in ${root}`, fix: 'Run your agent once, or point at them with `--sessions <dir>`. `demo` works without any.' });
  }

  const agent = runner ?? (config ? makeRunner('claude', config, undefined, undefined, ctx.cwd) : undefined);
  if (agent?.preflight) checks.push(...(await agent.preflight(ctx.cwd)));
  return checks;
}

export async function doctorCommand(ctx: Ctx, argv: string[]): Promise<number> {
  const { values } = parse(argv, { options: { help: { type: 'boolean' } } }, 'doctor');
  if (values.help) {
    ctx.stdout(DOCTOR_HELP);
    return 0;
  }
  const checks = await runDoctor(ctx);
  ctx.stdout(renderChecks(checks, ctx.color));
  const failed = checks.filter((c) => c.status === 'fail').length;
  ctx.stdout(failed === 0 ? ' Ready.' : ` ${failed} problem${failed === 1 ? '' : 's'} to fix before replaying.`);
  return failed === 0 ? 0 : 3;
}
