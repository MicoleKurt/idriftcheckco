import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempRepo {
  dir: string;
  git(...args: string[]): string;
  cleanup(): void;
}

/** Create a throwaway git repository containing `files`, with one commit. */
export function makeRepo(files: Record<string, string>): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), 'idc-test-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return {
    dir,
    git,
    cleanup() {
      try {
        git('worktree', 'prune');
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const DEMO_FILES: Record<string, string> = {
  'src/validate.js': 'export const validate = (s) => s;\n',
  'README.md': '# demo\n',
  'check.mjs':
    "import { readFileSync } from 'node:fs';\n" +
    "process.exit(readFileSync('src/validate.js', 'utf8').includes('trim()') ? 0 : 1);\n",
};
