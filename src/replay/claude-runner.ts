import { randomUUID } from 'node:crypto';
import { readFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseClaudeCodeSession } from '../adapters/claude-code.js';
import { encodeProjectDir, sessionsRoot } from '../adapters/discover.js';
import { clip, redactString } from '../redact/redact.js';
import type { Price } from '../trace/pricing.js';
import type { Trace } from '../trace/schema.js';
import { killTree, spawnManaged } from './proc.js';
import type { AgentRunner, Check, RunRequest } from './runner.js';

export interface ClaudeRunnerOptions {
  bin?: string;
  /** Arguments placed before the generated ones (wrappers such as `node fake-cli.mjs`). */
  binArgs?: string[];
  permissionMode?: string;
  /** Extra env var names to pass through (everything else is withheld). */
  envAllowlist?: string[];
  prices?: Record<string, Price>;
  /** Defaults to process.env; injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

/** Variables the agent CLI needs to start and authenticate. Everything else is withheld. */
const BASE_ENV = [
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT',
  'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'USERNAME',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_REGION', 'AWS_PROFILE',
];

/** Credentials that authenticate the agent without an interactive login. */
const CREDENTIAL_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];

export function buildEnv(source: NodeJS.ProcessEnv, extra: string[] = []): NodeJS.ProcessEnv {
  const allowed = new Set([...BASE_ENV, ...extra]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) if (allowed.has(k) && v !== undefined) out[k] = v;
  return out;
}

/** Args are validated, not escaped: a `.cmd` shim on Windows needs a shell, so refuse anything shell-active. */
const SAFE_ARG = /^[A-Za-z0-9_@+=:,./\\ \-[\]]+$/;

export interface ArgOptions {
  permissionMode: string;
  /**
   * Multi-turn replay: the first turn starts a persisted session with this id, later
   * turns resume it. Without it, runs are not persisted at all.
   */
  session?: { id: string; resume: boolean };
}

export function buildArgs(req: RunRequest, opts: ArgOptions): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', opts.permissionMode];
  if (!opts.session) args.push('--no-session-persistence');
  else args.push(opts.session.resume ? '--resume' : '--session-id', opts.session.id);
  const v = req.variant;
  if (v.model) args.push('--model', v.model);
  if (v.mcpConfig) args.push('--mcp-config', v.mcpConfig, '--strict-mcp-config');
  if (req.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(req.maxBudgetUsd));
  if (req.allowedTools && req.allowedTools.length > 0) args.push('--allowedTools', req.allowedTools.join(','));
  if (v.extraArgs) args.push(...v.extraArgs);
  for (const a of args) {
    if (!SAFE_ARG.test(a)) {
      throw new Error(`Refusing to pass argument "${a}" to the agent CLI: it contains shell-special characters. Rename the file or value.`);
    }
  }
  return args;
}

/** Patterns that mean the agent CLI could not authenticate (not a behavior regression). */
const AUTH_FAILURE = /failed to authenticate|oauth session expired|invalid api key|not logged in|authentication_error/i;
export const AUTH_HINT =
  'The agent CLI could not authenticate. Log in (`claude auth login`) or set ANTHROPIC_API_KEY, then re-run. This run says nothing about model behavior.';

function quoteForShell(a: string): string {
  return /\s/.test(a) ? `"${a}"` : a;
}

interface Invocation {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Drives the `claude` CLI headlessly (`-p --output-format stream-json`). The task is
 * written to stdin (no quoting hazards, no arg-length limits) and the stream is parsed
 * by the same adapter used for stored transcripts.
 *
 * Tested against a stand-in subprocess (stdin delivery, stream parsing, auth failure,
 * timeouts). The live stream shape should be re-checked with one tiny paid run when the
 * agent CLI version changes (see docs/replay-decision.md).
 */
export class ClaudeCodeRunner implements AgentRunner {
  readonly id = 'claude-code';
  readonly paid = true;
  constructor(private readonly opts: ClaudeRunnerOptions = {}) {}

  private get bin(): string {
    return this.opts.bin ?? 'claude';
  }

  /** Spawn the CLI with an allow-listed env, optional stdin and a tree-killing timeout. */
  private invoke(cliArgs: string[], o: { cwd: string; stdin?: string; timeoutMs: number; signal?: AbortSignal }): Promise<Invocation> {
    const args = [...(this.opts.binArgs ?? []), ...cliArgs];
    const env = buildEnv(this.opts.env ?? process.env, this.opts.envAllowlist);
    const bin = this.bin;
    return new Promise<Invocation>((resolveP, reject) => {
      // With a shell, pass ONE command string: Node deprecates (DEP0190) shell + args array.
      // Every generated arg was validated against SAFE_ARG, so concatenation is safe.
      const child =
        process.platform === 'win32'
          ? spawnManaged([bin, ...args].map(quoteForShell).join(' '), [], { cwd: o.cwd, env, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
          : spawnManaged(bin, args, { cwd: o.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, o.timeoutMs);
      o.signal?.addEventListener('abort', () => killTree(child), { once: true });
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-4000)));
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(e.code === 'ENOENT' ? new Error(`Could not start "${bin}". Install the agent CLI or set \`claudeBin\` in idriftcheckco.config.`) : e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolveP({ stdout: out, stderr: err, code, timedOut });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(o.stdin ?? '');
    });
  }

  /**
   * Free, local checks that catch a run that is doomed before any money is spent:
   * the CLI starts, and it is authenticated. Makes no model call.
   */
  async preflight(cwd: string): Promise<Check[]> {
    const checks: Check[] = [];
    let version: Invocation;
    try {
      version = await this.invoke(['--version'], { cwd, timeoutMs: 20_000 });
    } catch (e) {
      return [{ name: 'agent CLI', status: 'fail', detail: (e as Error).message, fix: 'Install the agent CLI, or set `claudeBin` in idriftcheckco.config.json.' }];
    }
    if (version.code !== 0) {
      return [{
        name: 'agent CLI', status: 'fail',
        detail: `\`${this.bin} --version\` exited with ${version.code}: ${clip(redactString((version.stderr || version.stdout).trim()), 160)}`,
        fix: 'Install the agent CLI, or set `claudeBin` in idriftcheckco.config.json.',
      }];
    }
    checks.push({ name: 'agent CLI', status: 'ok', detail: clip(version.stdout.trim().split('\n')[0] ?? '', 80) });

    const env = this.opts.env ?? process.env;
    const credential = CREDENTIAL_ENV.find((k) => env[k]);
    if (credential) {
      checks.push({ name: 'agent auth', status: 'ok', detail: `credentials from ${credential}` });
      return checks;
    }
    const auth = await this.invoke(['auth', 'status'], { cwd, timeoutMs: 20_000 }).catch(() => undefined);
    let loggedIn: boolean | undefined;
    try {
      loggedIn = (JSON.parse(auth?.stdout ?? '') as { loggedIn?: unknown }).loggedIn === true;
    } catch {
      loggedIn = undefined;
    }
    if (loggedIn === true) checks.push({ name: 'agent auth', status: 'ok', detail: 'logged in' });
    else if (loggedIn === false) {
      checks.push({ name: 'agent auth', status: 'fail', detail: 'the agent CLI is not logged in', fix: 'Run `claude auth login`, or set ANTHROPIC_API_KEY.' });
    } else {
      checks.push({ name: 'agent auth', status: 'warn', detail: 'could not determine login state', fix: 'If runs fail to authenticate, run `claude auth login`.' });
    }
    return checks;
  }

  async run(req: RunRequest): Promise<Trace> {
    let task = req.task;
    if (req.variant.promptFile) {
      const text = await readFile(req.variant.promptFile, 'utf8').catch(() => {
        throw new Error(`Prompt file ${req.variant.promptFile} could not be read.`);
      });
      // An inline arg would hit shell-quoting and length limits, so append to the task on stdin.
      task = `${task}\n\n<additional-instructions>\n${text}\n</additional-instructions>`;
    }
    const turns = [task, ...(req.followUps ?? [])];
    const session = turns.length > 1 ? randomUUID() : undefined;
    const permissionMode = this.opts.permissionMode ?? 'acceptEdits';
    const prices = this.opts.prices ? { prices: this.opts.prices } : {};
    const started = Date.now();

    const parts: Trace[] = [];
    const notes: string[] = [];
    let last: Invocation | undefined;
    try {
      for (let i = 0; i < turns.length; i++) {
        const remaining = req.timeoutMs - (Date.now() - started);
        if (remaining <= 0) break;
        const cliArgs = buildArgs(req, { permissionMode, ...(session ? { session: { id: session, resume: i > 0 } } : {}) });
        last = await this.invoke(cliArgs, { cwd: req.cwd, stdin: turns[i], timeoutMs: remaining, ...(req.signal ? { signal: req.signal } : {}) });
        parts.push(parseClaudeCodeSession(last.stdout, prices));
        // A failed turn ends the conversation: later prompts would answer a reply that never came.
        if (last.timedOut || last.code !== 0) {
          if (i < turns.length - 1) notes.push(`Stopped after turn ${i + 1} of ${turns.length}.`);
          break;
        }
      }
    } finally {
      if (session) await this.forgetSession(req.cwd, session);
    }
    if (!last) throw new Error('No time left to start the agent; raise timeoutMinutes.');

    const trace = mergeTurns(parts);
    // The stream does not echo the prompt, so this adapter note is expected noise here.
    notes.unshift(...trace.notes.filter((n) => !n.startsWith('No human prompt found')));
    if (turns.length > 1) notes.push(`Replayed ${parts.length} of ${turns.length} human turns in one agent session.`);
    const { stderr, code, timedOut } = last;
    if (timedOut) notes.push(`Timed out after ${Math.round(req.timeoutMs / 1000)}s and was stopped.`);
    if (code !== 0 && !timedOut) {
      const why = clip(redactString(stderr.trim() || trace.outcome.finalMessage || 'no output'), 300);
      notes.push(`Agent CLI exited with code ${code}: ${why}`);
    }
    if (AUTH_FAILURE.test(`${stderr} ${trace.outcome.finalMessage ?? ''}`)) notes.push(AUTH_HINT);
    const status = timedOut ? 'interrupted' : code !== 0 && trace.outcome.status !== 'completed' ? 'error' : trace.outcome.status;
    return {
      ...trace,
      source: { ...trace.source, kind: 'replay' },
      variant: req.variant,
      task: redactString(req.task),
      humanTurns: parts.length,
      followUps: (req.followUps ?? []).slice(0, Math.max(0, parts.length - 1)).map(redactString),
      durationMs: trace.durationMs ?? Date.now() - started,
      outcome: { ...trace.outcome, status },
      notes,
    };
  }

  /**
   * A multi-turn replay has to persist its session so later turns can resume it. Delete
   * that transcript afterwards so replays never show up in the user's own session list.
   */
  private async forgetSession(cwd: string, id: string): Promise<void> {
    const env = this.opts.env ?? process.env;
    const dir = join(sessionsRoot(undefined, env), encodeProjectDir(cwd));
    await rm(join(dir, `${id}.jsonl`), { force: true }).catch(() => undefined);
    await rmdir(dir).catch(() => undefined); // only succeeds when empty
  }
}

/** Combine the traces of consecutive turns of one agent session into one trace. */
export function mergeTurns(parts: Trace[]): Trace {
  const [first, ...rest] = parts;
  if (!first) throw new Error('mergeTurns needs at least one turn.');
  if (rest.length === 0) return first;
  const all = [first, ...rest];
  const lastPart = all[all.length - 1]!;
  const sum = (f: (t: Trace) => number) => all.reduce((s, t) => s + f(t), 0);
  const costs = all.map((t) => t.costUsd);
  const allKnown = costs.every((c): c is number => c !== null);
  const durations = all.map((t) => t.durationMs);
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  return {
    ...first,
    steps: all.flatMap((t) => t.steps).map((s, i) => ({ ...s, index: i })),
    usage: {
      inputTokens: sum((t) => t.usage.inputTokens),
      outputTokens: sum((t) => t.usage.outputTokens),
      cacheReadTokens: sum((t) => t.usage.cacheReadTokens),
      cacheWriteTokens: sum((t) => t.usage.cacheWriteTokens),
    },
    costUsd: allKnown ? Math.round(costs.reduce((s, c) => s + c, 0) * 1e6) / 1e6 : null,
    costSource: !allKnown ? 'unknown' : all.every((t) => t.costSource === 'reported') ? 'reported' : 'estimated',
    durationMs: durations.every((d): d is number => d !== null) ? durations.reduce((s, d) => s + d, 0) : null,
    filesChanged: uniq(all.flatMap((t) => t.filesChanged)),
    filesRead: uniq(all.flatMap((t) => t.filesRead)),
    ...(lastPart.endedAt ? { endedAt: lastPart.endedAt } : {}),
    outcome: lastPart.outcome,
    notes: [...new Set(all.flatMap((t) => t.notes))],
  };
}
