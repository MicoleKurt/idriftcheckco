import { resolve } from 'node:path';
import { exitCodeFor } from '../../diff/diff.js';
import { loadConfig } from '../../config.js';
import { renderJson } from '../../report/json.js';
import { renderMarkdown } from '../../report/markdown.js';
import { renderTerminal } from '../../report/terminal.js';
import { Store } from '../../store/store.js';
import type { Variant } from '../../trace/schema.js';
import { num, parse, UsageError, type Ctx } from '../context.js';
import { resolveSourceTrace } from './import.js';
import { executeReplay, makeRunner } from '../run.js';

export const REPLAY_HELP = `idriftcheckco replay <trace> [change...]

Re-run a recorded task under a changed condition and diff the behavior. Runs happen
in isolated git worktrees; your checkout is never touched.

By default the UNCHANGED setup is re-run as a "control" so the comparison is fair
(same task, same repo state, no human in the loop). Each arm runs --runs times so
the report shows variance, not a single lucky sample.

What to change (at least one)
  --model <id>          Different model
  --prompt-file <f>     Extra instructions appended to the task
  --mcp-config <f>      Different MCP server config (strict: only these servers)
  --overlay DEST=SRC    Copy SRC into the worktree at DEST (repeatable), e.g.
                        --overlay CLAUDE.md=./CLAUDE.new.md

Options
  --name <label>        Name for the candidate arm (default: the model)
  --control-model <id>  Model for the control arm (default: the original session's)
  --no-control          Compare against the original session instead (cheaper, weaker)
  --runs <n>            Runs per arm (default from config, 3). Use 4+ for significance.
  --ref <commit>        Commit to replay on (default HEAD). Use the commit the session started from.
  --check <cmd>         Command run after each attempt; exit 0 = pass (e.g. "pnpm test")
  --dry-run             Print the cost estimate and exit
  --max-cost <usd>      Stop launching runs once this much is spent
  --yes                 Skip the cost confirmation (required in CI)
  --format <f>          terminal (default) | json | markdown
  --fail-on <level>     Exit 1 on: regression (default when set) | drift
  --out <file>          Also write the HTML report here
`;

export function parseOverlays(items: string[] | undefined): Record<string, string> | undefined {
  if (!items || items.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const item of items) {
    const i = item.indexOf('=');
    if (i <= 0 || i === item.length - 1) throw new UsageError(`--overlay expects DEST=SRC, got "${item}".`);
    out[item.slice(0, i)] = item.slice(i + 1);
  }
  return out;
}

/** Options shared by `replay` and `ci`. */
export const REPLAY_OPTIONS = {
  model: { type: 'string' }, 'control-model': { type: 'string' }, 'prompt-file': { type: 'string' },
  'mcp-config': { type: 'string' }, overlay: { type: 'string', multiple: true }, name: { type: 'string' },
  runs: { type: 'string' }, ref: { type: 'string' }, check: { type: 'string' }, 'dry-run': { type: 'boolean' },
  'max-cost': { type: 'string' }, yes: { type: 'boolean' }, 'no-control': { type: 'boolean' },
  runner: { type: 'string', default: 'claude' }, scenario: { type: 'string' }, seed: { type: 'string' },
  format: { type: 'string', default: 'terminal' }, 'fail-on': { type: 'string' }, out: { type: 'string' },
} as const;

export function variantFromFlags(cwd: string, v: {
  model?: string | undefined; 'prompt-file'?: string | undefined; 'mcp-config'?: string | undefined;
  overlay?: string[] | undefined; name?: string | undefined;
}): Variant {
  const files = parseOverlays(v.overlay);
  if (!v.model && !v['prompt-file'] && !v['mcp-config'] && !files) {
    throw new UsageError('Nothing to change. Pass --model, --prompt-file, --mcp-config or --overlay.');
  }
  return {
    name: v.name ?? v.model ?? 'candidate',
    ...(v.model ? { model: v.model } : {}),
    ...(v['prompt-file'] ? { promptFile: resolve(cwd, v['prompt-file']) } : {}),
    ...(v['mcp-config'] ? { mcpConfig: resolve(cwd, v['mcp-config']) } : {}),
    ...(files ? { files } : {}),
  };
}

export function failOn(value: string | undefined): 'regression' | 'drift' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'regression' && value !== 'drift') throw new UsageError(`--fail-on must be "regression" or "drift", got "${value}".`);
  return value;
}

export async function replayCommand(ctx: Ctx, argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { options: { ...REPLAY_OPTIONS, help: { type: 'boolean' } } }, 'replay');
  if (values.help) {
    ctx.stdout(REPLAY_HELP);
    return 0;
  }
  if (positionals.length !== 1) throw new UsageError('Pass exactly one trace id or path, e.g. `idriftcheckco replay a1b2c3 --model <model>`. List traces with `scan` or `import`.');
  const { config } = await loadConfig(ctx.cwd);
  const store = new Store(ctx.cwd, config.storeDir);
  const source = await resolveSourceTrace(ctx, config, store, positionals[0]!);
  const variant = variantFromFlags(ctx.cwd, values);
  const runs = num(values.runs, 'runs', 1) ?? config.runs;
  const runner = makeRunner(values.runner, config, values.scenario, num(values.seed, 'seed'), ctx.cwd);
  const fail = failOn(values['fail-on']);

  const res = await executeReplay({
    ctx, config, store, source,
    candidate: { name: variant.name, variant, runs },
    control: !values['no-control'],
    ...(values['control-model'] ? { controlVariant: { name: 'control', model: values['control-model'] } } : {}),
    ...(values.ref ? { ref: values.ref } : {}),
    ...(values.check ? { check: values.check } : {}),
    ...(num(values['max-cost'], 'max-cost') !== undefined ? { maxCostUsd: num(values['max-cost'], 'max-cost')! } : {}),
    runner, dryRun: Boolean(values['dry-run']), yes: Boolean(values.yes), baseDir: ctx.cwd,
    ...(values.out ? { htmlPath: resolve(ctx.cwd, values.out) } : {}),
  });
  if (!res.report) return 0;

  switch (values.format) {
    case 'json':
      ctx.stdout(renderJson(res.report, fail ?? 'regression'));
      break;
    case 'markdown':
      ctx.stdout(renderMarkdown(res.report));
      break;
    case 'terminal':
      ctx.stdout(renderTerminal(res.report, { color: ctx.color }));
      break;
    default:
      throw new UsageError(`Unknown --format "${values.format}". Use terminal, json or markdown.`);
  }
  ctx.stderr(` Report: file:///${res.reportPath!.replace(/\\/g, '/')}`);
  ctx.stderr(` Run id: ${res.runId}   (re-render any time: idriftcheckco report ${res.runId})`);
  if (res.truncated) ctx.stderr(' Note: replay stopped early at the spending cap; results use fewer runs than requested.');
  return fail ? exitCodeFor(res.report.verdict, fail) : 0;
}
