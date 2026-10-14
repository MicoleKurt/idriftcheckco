import { resolve } from 'node:path';
import { runDemo } from '../demo.js';
import { renderTerminal } from '../report/terminal.js';
import { VERSION } from '../version.js';
import { ciCommand, CI_HELP } from './commands/ci.js';
import { diffCommand, DIFF_HELP } from './commands/diff.js';
import { importCommand, IMPORT_HELP } from './commands/import.js';
import { recordCommand, RECORD_HELP } from './commands/record.js';
import { replayCommand, REPLAY_HELP } from './commands/replay.js';
import { reportCommand, REPORT_HELP } from './commands/report.js';
import { scanCommand, SCAN_HELP } from './commands/scan.js';
import { EXIT, realContext, UsageError, type Ctx } from './context.js';

const HELP = `idriftcheckco ${VERSION}: regression tests for AI agents

Upgrade your model or prompt without silently breaking your agent. Replays the
sessions you already have under a changed condition and diffs the behavior.
Local-first: no telemetry; the only network traffic is your own agent's API calls.

Usage
  idriftcheckco                          Find your sessions and rank them for replay
  idriftcheckco demo                     See a full regression report, offline, free
  idriftcheckco import [session...]      Save sessions as redacted traces
  idriftcheckco replay <trace> --model <id> [--runs 4] [--dry-run]
  idriftcheckco diff <a> [b]             Compare runs
  idriftcheckco report [runId]           Render the HTML report
  idriftcheckco ci [...]                 Gate a pipeline (exit 1 on regression)
  idriftcheckco record "<task>"          Run a task once to create a baseline

Run \`idriftcheckco <command> --help\` for details.
Exit codes: 0 ok · 1 regression found · 2 bad invocation · 3 runtime failure
`;

const DEMO_HELP = `idriftcheckco demo [--out <file>]

Replays a scripted scenario through the real pipeline (git worktrees, ground-truth
file diffs, a check command, variance statistics) and writes the HTML report.
No API key and no network. Default output: ./idriftcheckco-demo.html
`;

async function demoCommand(ctx: Ctx, argv: string[]): Promise<number> {
  if (argv.includes('--help')) {
    ctx.stdout(DEMO_HELP);
    return 0;
  }
  const i = argv.indexOf('--out');
  const out = resolve(ctx.cwd, i >= 0 && argv[i + 1] ? argv[i + 1]! : 'idriftcheckco-demo.html');
  ctx.stderr(' Replaying a scripted agent upgrade (4 runs per side) in isolated git worktrees…');
  const quiet: Ctx = { ...ctx, stderr: () => undefined };
  const { report, reportPath } = await runDemo(quiet, out);
  ctx.stdout(renderTerminal(report, { color: ctx.color }));
  ctx.stdout(` Full report: file:///${reportPath.replace(/\\/g, '/')}`);
  ctx.stdout(' That was a scripted agent. To test your real one: npx idriftcheckco');
  return 0;
}

const COMMANDS: Record<string, (ctx: Ctx, argv: string[]) => Promise<number>> = {
  scan: scanCommand, import: importCommand, replay: replayCommand, diff: diffCommand,
  report: reportCommand, ci: ciCommand, record: recordCommand, demo: demoCommand,
};

const HELPS: Record<string, string> = {
  scan: SCAN_HELP, import: IMPORT_HELP, replay: REPLAY_HELP, diff: DIFF_HELP, report: REPORT_HELP, ci: CI_HELP, record: RECORD_HELP, demo: DEMO_HELP,
};

export async function main(argv: string[], ctx: Ctx = realContext()): Promise<number> {
  const [first, ...rest] = argv;
  try {
    if (first === '--version' || first === '-v') {
      ctx.stdout(VERSION);
      return EXIT.ok;
    }
    if (first === 'help' || first === '--help' || first === '-h') {
      const topic = rest[0];
      ctx.stdout(topic && HELPS[topic] ? HELPS[topic]! : HELP);
      return EXIT.ok;
    }
    // No subcommand (or only flags): behave like `scan` so `npx idriftcheckco` just works.
    const isFlag = first === undefined || first.startsWith('-');
    const name = isFlag ? 'scan' : first;
    const run = COMMANDS[name];
    if (!run) throw new UsageError(`Unknown command "${name}". Run \`idriftcheckco help\` to see commands.`);
    return await run(ctx, isFlag ? argv : rest);
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.stderr(`idriftcheckco: ${e.message}`);
      return EXIT.usage;
    }
    const err = e as Error;
    ctx.stderr(`idriftcheckco: ${err.message}`);
    if (ctx.env.IDRIFTCHECKCO_DEBUG && err.stack) ctx.stderr(err.stack);
    return EXIT.runtime;
  }
}
