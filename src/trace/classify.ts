import type { ToolCategory } from './schema.js';

const READ = new Set(['Read', 'NotebookRead']);
const WRITE = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCH = new Set(['Grep', 'Glob', 'LS', 'ToolSearch']);
const EXEC = new Set(['Bash', 'PowerShell', 'BashOutput', 'KillShell']);
const AGENT = new Set(['Agent', 'Task']);
const WEB = new Set(['WebFetch', 'WebSearch']);

export function categorize(name: string): ToolCategory {
  if (name.startsWith('mcp__')) return 'mcp';
  if (READ.has(name)) return 'read';
  if (WRITE.has(name)) return 'write';
  if (SEARCH.has(name)) return 'search';
  if (EXEC.has(name)) return 'exec';
  if (AGENT.has(name)) return 'agent';
  if (WEB.has(name)) return 'web';
  return 'other';
}

/** Normalize a path to forward slashes and, when under `cwd`, make it relative. */
export function normalizePath(p: string, cwd?: string): string {
  let out = p.replace(/\\/g, '/');
  if (cwd) {
    const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (out.length > base.length && same(out.slice(0, base.length), base) && out[base.length] === '/') {
      out = out.slice(base.length + 1);
    }
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Extract the thing a tool call acted on. */
export function targetOf(
  name: string,
  category: ToolCategory,
  input: Record<string, unknown>,
  cwd?: string,
): string | undefined {
  switch (category) {
    case 'read':
    case 'write': {
      const p = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
      return p ? normalizePath(p, cwd) : undefined;
    }
    case 'search':
      return str(input.pattern) ?? str(input.path) ?? str(input.query);
    case 'exec': {
      const c = str(input.command);
      return c ? c.split('\n')[0]!.slice(0, 160) : undefined;
    }
    case 'web':
      return str(input.url) ?? str(input.query);
    case 'agent':
      return str(input.subagent_type) ?? str(input.description) ?? name;
    default:
      return undefined;
  }
}

/**
 * Reduce a shell command to a comparable signature:
 * `cd app && pnpm run test -- foo` -> `pnpm run test`, `git status -s` -> `git status`.
 */
export function commandSignature(command: string): string {
  const segments = command.split(/&&|;|\|\|/).map((s) => s.trim());
  const last = segments.filter((s) => s && !/^cd\s/.test(s)).pop() ?? command.trim();
  const tokens = last.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  const first = tokens[0] ?? '';
  const take = ['npm', 'pnpm', 'yarn', 'bun'].includes(first) && tokens[1] === 'run' ? 3 : 2;
  return tokens.slice(0, take).join(' ');
}

const VERIFY =
  /\b(test|tests|vitest|jest|mocha|pytest|tox|tsc|typecheck|type-check|lint|eslint|ruff|mypy|build|check|verify|clippy|vet)\b|dotnet test|mvn|gradle/i;

/** True when a command looks like verification (tests, types, lint, build). */
export function isVerificationCommand(command: string): boolean {
  return VERIFY.test(commandSignature(command));
}
