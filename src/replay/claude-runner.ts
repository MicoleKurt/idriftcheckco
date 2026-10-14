import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseClaudeCodeSession } from '../adapters/claude-code.js';
import { clip, redactString } from '../redact/redact.js';
import type { Price } from '../trace/pricing.js';
import type { Trace } from '../trace/schema.js';
import { killTree } from './proc.js';
import type { AgentRunner, RunRequest } from './runner.js';

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

export function buildEnv(source: NodeJS.ProcessEnv, extra: string[] = []): NodeJS.ProcessEnv {
  const allowed = new Set([...BASE_ENV, ...extra]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) if (allowed.has(k) && v !== undefined) out[k] = v;
  return out;
}

/** Args are validated, not escaped: a `.cmd` shim on Windows needs a shell, so refuse anything shell-active. */
const SAFE_ARG = /^[A-Za-z0-9_@+=:,./\\ \-[\]]+$/;

export function buildArgs(req: RunRequest, opts: { permissionMode: string; systemPromptText?: string }): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', opts.permissionMode];
  const v = req.variant;
  if (v.model) args.push('--model', v.model);
  if (v.mcpConfig) args.push('--mcp-config', v.mcpConfig, '--strict-mcp-config');
  if (req.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(req.maxBudgetUsd));
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

/**
 * Drives the `claude` CLI headlessly (`-p --output-format stream-json`). The task is
 * written to stdin (no quoting hazards, no arg-length limits) and the stream is
 * parsed by the same adapter used for stored transcripts.
 *
 * NOTE: the stream-json event shape is assumed to match transcript entries; this has
 * been verified for message/tool_use/tool_result shapes but should be re-checked with
 * a real paid run when the CLI version changes (see docs/replay-decision.md).
 */
export class ClaudeCodeRunner implements AgentRunner {
  readonly id = 'claude-code';
  readonly paid = true;
  constructor(private readonly opts: ClaudeRunnerOptions = {}) {}

  async run(req: RunRequest): Promise<Trace> {
    const bin = this.opts.bin ?? 'claude';
    const args = [...(this.opts.binArgs ?? []), ...buildArgs(req, { permissionMode: this.opts.permissionMode ?? 'acceptEdits' })];
    if (req.variant.promptFile) {
      const text = await readFile(req.variant.promptFile, 'utf8').catch(() => {
        throw new Error(`Prompt file ${req.variant.promptFile} could not be read.`);
      });
      // Passed via a temp-free route: inline arg would hit shell-quoting limits, so append to the task.
      req = { ...req, task: `${req.task}\n\n<additional-instructions>\n${text}\n</additional-instructions>` };
    }
    const env = buildEnv(this.opts.env ?? process.env, this.opts.envAllowlist);
    const useShell = process.platform === 'win32';
    const started = Date.now();

    const { stdout, stderr, code, timedOut } = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>(
      (resolveP, reject) => {
        // With a shell, pass ONE command string: Node deprecates (DEP0190) shell + args array.
        // Every arg was validated against SAFE_ARG, so concatenation is safe.
        const child = useShell
          ? spawn([bin, ...args].map(quoteForShell).join(' '), { cwd: req.cwd, env, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
          : spawn(bin, args, { cwd: req.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        let timedOutFlag = false;
        const timer = setTimeout(() => {
          timedOutFlag = true;
          killTree(child);
        }, req.timeoutMs);
        req.signal?.addEventListener('abort', () => killTree(child), { once: true });
        child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
        child.stderr.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-4000)));
        child.on('error', (e: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          reject(
            e.code === 'ENOENT'
              ? new Error(`Could not start "${bin}". Install the agent CLI or set \`claudeBin\` in idriftcheckco.config. `)
              : e,
          );
        });
        child.on('close', (c) => {
          clearTimeout(timer);
          resolveP({ stdout: out, stderr: err, code: c, timedOut: timedOutFlag });
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(req.task);
      },
    );

    const trace = parseClaudeCodeSession(stdout, { ...(this.opts.prices ? { prices: this.opts.prices } : {}) });
    // The stream does not echo the prompt, so this adapter note is expected noise here.
    const notes = trace.notes.filter((n) => !n.startsWith('No human prompt found'));
    if (timedOut) notes.push(`Timed out after ${Math.round(req.timeoutMs / 1000)}s and was stopped.`);
    if (code !== 0 && !timedOut) {
      const why = clip(redactString(stderr.trim() || trace.outcome.finalMessage || 'no output'), 300);
      notes.push(`Agent CLI exited with code ${code}: ${why}`);
    }
    if (AUTH_FAILURE.test(`${stderr} ${trace.outcome.finalMessage ?? ''}`)) {
      notes.push(AUTH_HINT);
    }
    const status = timedOut ? 'interrupted' : code !== 0 && trace.outcome.status !== 'completed' ? 'error' : trace.outcome.status;
    return {
      ...trace,
      source: { ...trace.source, kind: 'replay' },
      variant: req.variant,
      task: redactString(req.task),
      durationMs: trace.durationMs ?? Date.now() - started,
      outcome: { ...trace.outcome, status },
      notes,
    };
  }
}
