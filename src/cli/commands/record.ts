import { loadConfig } from '../../config.js';
import { runReplay } from '../../replay/replay.js';
import { Store } from '../../store/store.js';
import { num, parse, UsageError, type Ctx } from '../context.js';
import { preflightOrThrow } from '../checks.js';
import { makeRunner } from '../run.js';

export const RECORD_HELP = `idriftcheckco record "<task>"

Run a task once with the agent, in an isolated worktree, and store the result as a
baseline trace. Use this when you have no suitable past session to import.
This makes a real, paid agent run.

Options
  --model <id>     Model to run with
  --ref <commit>   Commit to run on (default HEAD)
  --check <cmd>    Command to run afterwards; exit 0 = pass
  --max-cost <usd> Spending cap for the run
  --yes            Skip the cost confirmation
`;

export async function recordCommand(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    options: {
      model: { type: 'string' }, ref: { type: 'string' }, check: { type: 'string' }, 'max-cost': { type: 'string' },
      yes: { type: 'boolean' }, runner: { type: 'string', default: 'claude' }, scenario: { type: 'string' },
      seed: { type: 'string' }, help: { type: 'boolean' },
    },
  }, 'record');
  if (values.help) {
    ctx.stdout(RECORD_HELP);
    return 0;
  }
  const task = positionals.join(' ').trim();
  if (!task) throw new UsageError('Pass the task to run, e.g. `idriftcheckco record "fix the failing pagination test"`.');
  const { config } = await loadConfig(ctx.cwd);
  const store = new Store(ctx.cwd, config.storeDir);
  const runner = makeRunner(values.runner, config, values.scenario, num(values.seed, 'seed'), ctx.cwd);
  await preflightOrThrow(ctx, runner, false);
  if (runner.paid && !values.yes && !(await ctx.confirm('This makes a real agent run and spends API credit. Continue?'))) {
    throw new UsageError(ctx.interactive ? 'Cancelled.' : 'No terminal to confirm on. Re-run with --yes.');
  }
  const cap = num(values['max-cost'], 'max-cost') ?? config.maxCostUsd;
  const variant = { name: 'recorded', ...(values.model ? { model: values.model } : {}) };
  const res = await runReplay({
    repo: ctx.cwd, ...(values.ref ? { ref: values.ref } : {}), task,
    arms: [{ name: 'recorded', variant, runs: 1 }], runner,
    ...((values.check ?? config.check) ? { check: (values.check ?? config.check)! } : {}),
    timeoutMs: Math.round(config.timeoutMinutes * 60_000), ...(cap !== undefined ? { maxCostUsd: cap } : {}), baseDir: ctx.cwd,
  });
  const trace = res.arms['recorded']?.[0];
  if (!trace) throw new Error('The run did not complete. ' + res.notes.join(' '));
  const authNote = trace.notes.find((n) => n.startsWith('The agent CLI could not authenticate'));
  if (authNote) throw new Error(authNote + ' Nothing was saved.');
  const path = await store.saveTrace(trace);
  ctx.stdout(`recorded ${trace.id.slice(0, 12)}  ${trace.outcome.status}  ${trace.filesChanged.length} file(s) changed`);
  ctx.stdout(`         → ${path}`);
  return 0;
}
