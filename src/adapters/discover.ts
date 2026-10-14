import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseClaudeCodeSession } from './claude-code.js';
import type { Price } from '../trace/pricing.js';
import type { Trace } from '../trace/schema.js';

export interface SessionFile {
  path: string;
  /** Encoded project directory name, e.g. `C--Users-me-app`. */
  project: string;
  sessionId: string;
  bytes: number;
  mtimeMs: number;
}

/** Where session transcripts live: explicit dir, $CLAUDE_CONFIG_DIR, or ~/.claude. */
export function sessionsRoot(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = explicit ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return join(base, 'projects');
}

/**
 * The transcript directory name for a working directory: every character that is
 * not a letter, digit or hyphen becomes `-` (observed behaviour, see docs/session-format.md).
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** List session files, newest first. `project` limits to a working directory. */
export async function listSessionFiles(root: string, project?: string): Promise<SessionFile[]> {
  const dirs = project ? [encodeProjectDir(project)] : await safeReaddir(root);
  const out: SessionFile[] = [];
  for (const d of dirs) {
    for (const f of await safeReaddir(join(root, d))) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(root, d, f);
      try {
        const s = await stat(path);
        if (s.isFile()) out.push({ path, project: d, sessionId: basename(f, '.jsonl'), bytes: s.size, mtimeMs: s.mtimeMs });
      } catch {
        /* file vanished; skip */
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function loadSession(file: SessionFile, prices?: Record<string, Price>): Promise<Trace> {
  return parseClaudeCodeSession(await readFile(file.path, 'utf8'), { sessionId: file.sessionId, ...(prices ? { prices } : {}) });
}
