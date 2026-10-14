import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { clip, redactString } from '../redact/redact.js';
import type { CheckResult } from '../trace/schema.js';
import { killTree } from './proc.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') throw new Error('git was not found on PATH. Install git; replay needs it to isolate runs.', { cause: e });
    throw new Error(`git ${args.join(' ')} failed: ${(err.stderr ?? err.message).trim()}`, { cause: e });
  }
}

export interface Worktree {
  path: string;
  /** Files the agent added, modified or deleted, relative to the checkout (ground truth). */
  changedFiles(): Promise<string[]>;
  /** Copy files into the worktree (variant overlays such as CLAUDE.md). */
  overlay(files: Record<string, string>, fromDir: string): Promise<void>;
  /** Run a shell command in the worktree; never throws on a non-zero exit. */
  runCheck(command: string, timeoutMs: number): Promise<CheckResult>;
  cleanup(): Promise<void>;
}

/** Parse `git status --porcelain=v1 -z` output into file paths. */
export function parsePorcelainZ(out: string): string[] {
  const files: string[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    files.push(entry.slice(3));
    // Renames/copies list the original path as the next NUL-separated token.
    if (code.includes('R') || code.includes('C')) i++;
  }
  return [...new Set(files.map((f) => f.replace(/\\/g, '/')))].sort();
}

/**
 * Create a detached git worktree of `ref` in the OS temp dir. The user's checkout
 * and working tree are never modified. Uncommitted changes in the user's checkout
 * are NOT carried over: replay what was committed.
 */
export async function createWorktree(repo: string, ref = 'HEAD'): Promise<Worktree> {
  const top = (await git(repo, ['rev-parse', '--show-toplevel']).catch(() => {
    throw new Error(
      `${repo} is not inside a git repository. Replay runs in an isolated git worktree; run \`git init\` and commit first.`,
    );
  })).trim();
  const dir = await mkdtemp(join(tmpdir(), 'idriftcheckco-'));
  const path = join(dir, 'wt');
  await git(top, ['worktree', 'add', '--detach', path, ref]);

  return {
    path,
    async changedFiles() {
      return parsePorcelainZ(await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    },
    async overlay(files, fromDir) {
      for (const [dest, src] of Object.entries(files)) {
        const target = resolve(path, dest);
        if (target !== path && !target.startsWith(path + sep)) {
          throw new Error(`Overlay destination "${dest}" escapes the worktree. Use a relative path inside the repo.`);
        }
        await mkdir(dirname(target), { recursive: true });
        await copyFile(resolve(fromDir, src), target).catch(() => {
          throw new Error(`Overlay source "${src}" for "${dest}" was not found.`);
        });
      }
    },
    runCheck(command, timeoutMs) {
      return new Promise<CheckResult>((resolveP) => {
        const child = spawn(command, { cwd: path, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let buf = '';
        const onData = (d: Buffer) => {
          buf = (buf + d.toString('utf8')).slice(-4000);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        const timer = setTimeout(() => killTree(child), timeoutMs);
        child.on('error', (e) => {
          clearTimeout(timer);
          resolveP({ command, exitCode: 127, outputTail: clip(redactString(String(e.message)), 400) });
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolveP({ command, exitCode: code ?? 124, outputTail: clip(redactString(buf.trim().slice(-400)), 400) });
        });
      });
    },
    async cleanup() {
      await git(top, ['worktree', 'remove', '--force', path]).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
