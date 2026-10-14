import { createInterface } from 'node:readline/promises';
import { parseArgs, type ParseArgsConfig } from 'node:util';

/** Bad invocation (exit code 2). The message must say what to do instead. */
export class UsageError extends Error {}

export const EXIT = { ok: 0, regression: 1, usage: 2, runtime: 3 } as const;

export interface Ctx {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout(s: string): void;
  stderr(s: string): void;
  color: boolean;
  interactive: boolean;
  /** Ask a yes/no question. Resolves false when not interactive. */
  confirm(question: string): Promise<boolean>;
}

export function realContext(): Ctx {
  const noColor = 'NO_COLOR' in process.env;
  const forced = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0';
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (s) => void process.stdout.write(s.endsWith('\n') ? s : s + '\n'),
    stderr: (s) => void process.stderr.write(s.endsWith('\n') ? s : s + '\n'),
    color: !noColor && (forced || Boolean(process.stdout.isTTY)),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async confirm(question) {
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
        return a === 'y' || a === 'yes';
      } finally {
        rl.close();
      }
    },
  };
}

/** `parseArgs` that reports problems as UsageErrors with a pointer to help. */
export function parse<T extends ParseArgsConfig>(argv: string[], config: T, command: string) {
  try {
    return parseArgs({ ...config, args: argv, strict: true, allowPositionals: true });
  } catch (e) {
    throw new UsageError(`${(e as Error).message.replace(/\.$/, '')}. Run \`idriftcheckco ${command} --help\` for options.`);
  }
}

export function num(value: string | undefined, name: string, min = 0): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new UsageError(`--${name} must be a number >= ${min}, got "${value}".`);
  return n;
}
