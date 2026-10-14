import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../../config.js';
import type { DiffReport } from '../../diff/types.js';
import { badgeForVerdict, toSuiteResult } from '../../report/json.js';
import { renderSuiteMarkdown } from '../../report/markdown.js';
import { renderTerminal } from '../../report/terminal.js';
import { Store } from '../../store/store.js';
import { num, parse, UsageError, type Ctx } from '../context.js';
import { executeReplay, makeRunner } from '../run.js';
import { diffRun } from './diff.js';
import { failOn, REPLAY_OPTIONS, turnsFlag, variantFromFlags } from './replay.js';

export const CI_HELP = `idriftcheckco ci

Gate a pipeline on agent behavior. Exit codes: 0 pass, 1 regression found,
2 bad invocation, 3 runtime failure.

Two modes
  Evaluate stored runs (free):   idriftcheckco ci --run latest
  Replay the suite, then gate:   idriftcheckco ci --model <id> --runs 4 --yes --max-cost 10
The suite is the traces listed under "suite" in the config, or every stored trace.

Options (replay mode accepts everything \`replay\` does, plus)
  --run <id>          Stored run to evaluate (default: latest). Repeatable.
  --traces <a,b>      Replay only these trace ids
  --fail-on <level>   regression (default) | drift
  --format <f>        terminal (default) | json | markdown
  --json-out <file>   Write the machine-readable result
  --md-out <file>     Write the PR-comment markdown
  --badge-out <file>  Write a shields.io endpoint JSON for a README badge
`;

export async function ciCommand(ctx: Ctx, argv: string[]): Promise<number> {
  const { values } = parse(argv, {
    options: {
      ...REPLAY_OPTIONS, run: { type: 'string', multiple: true }, traces: { type: 'string' },
      'json-out': { type: 'string' }, 'md-out': { type: 'string' }, 'badge-out': { type: 'string' }, help: { type: 'boolean' },
    },
  }, 'ci');
  if (values.help) {
    ctx.stdout(CI_HELP);
    return 0;
  }
  const { config } = await loadConfig(ctx.cwd);
  const store = new Store(ctx.cwd, config.storeDir);
  const fail = failOn(values['fail-on']) ?? 'regression';
  const items: Array<{ task: string; report: DiffReport }> = [];

  const replayMode = Boolean(values.model || values['prompt-file'] || values['mcp-config'] || values.overlay);
  if (replayMode) {
    const variant = variantFromFlags(ctx.cwd, values);
    const ids = values.traces ? values.traces.split(',').map((s) => s.trim()).filter(Boolean) : config.suite;
    const sources = ids.length > 0 ? await Promise.all(ids.map((id) => store.resolveTrace(id))) : await store.listTraces();
    if (sources.length === 0) throw new UsageError('The suite is empty. Import sessions with `idriftcheckco import`, or list ids under "suite" in the config.');
    const runner = makeRunner(values.runner, config, values.scenario, num(values.seed, 'seed'), ctx.cwd);
    let remaining = num(values['max-cost'], 'max-cost') ?? config.maxCostUsd;
    for (const source of sources) {
      if (remaining !== undefined && remaining <= 0) {
        ctx.stderr(`  ! Spending cap reached; skipped ${source.id.slice(0, 8)} and any remaining tasks.`);
        break;
      }
      const res = await executeReplay({
        ctx, config, store, source,
        candidate: { name: variant.name, variant, runs: num(values.runs, 'runs', 1) ?? config.runs },
        control: !values['no-control'],
        ...(values['control-model'] ? { controlVariant: { name: 'control', model: values['control-model'] } } : {}),
        ...(values.ref ? { ref: values.ref } : {}),
        ...(turnsFlag(values.turns) ? { turns: turnsFlag(values.turns)! } : {}),
        ...(values.check ? { check: values.check } : {}),
        ...(remaining !== undefined ? { maxCostUsd: remaining } : {}),
        runner, dryRun: Boolean(values['dry-run']), yes: Boolean(values.yes), baseDir: ctx.cwd,
      });
      if (res.report) items.push({ task: source.task, report: res.report });
      if (remaining !== undefined && res.spentUsd !== undefined) remaining -= res.spentUsd;
    }
    if (values['dry-run']) return 0;
  } else {
    const runs = values.run && values.run.length > 0 ? values.run : ['latest'];
    for (const id of runs) {
      const r = await diffRun(store, id, config);
      const meta = (await store.loadRun(id)).meta;
      items.push({ task: meta.task, report: r.report });
    }
  }
  if (items.length === 0) throw new Error('No results to evaluate.');

  const suite = toSuiteResult(items, fail);
  switch (values.format) {
    case 'json':
      ctx.stdout(JSON.stringify(suite, null, 2));
      break;
    case 'markdown':
      ctx.stdout(renderSuiteMarkdown(items));
      break;
    case 'terminal':
      for (const i of items) ctx.stdout(renderTerminal(i.report, { color: ctx.color }));
      break;
    default:
      throw new UsageError(`Unknown --format "${values.format}". Use terminal, json or markdown.`);
  }
  if (values['json-out']) await writeFile(resolve(ctx.cwd, values['json-out']), JSON.stringify(suite, null, 2) + '\n', 'utf8');
  if (values['md-out']) await writeFile(resolve(ctx.cwd, values['md-out']), renderSuiteMarkdown(items), 'utf8');
  if (values['badge-out']) await writeFile(resolve(ctx.cwd, values['badge-out']), JSON.stringify(badgeForVerdict(suite.verdict)) + '\n', 'utf8');
  ctx.stderr(`idriftcheckco ci: ${suite.verdict} across ${items.length} task${items.length === 1 ? '' : 's'} → exit ${suite.exitCode}`);
  return suite.exitCode;
}
