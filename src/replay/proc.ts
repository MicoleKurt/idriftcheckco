import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';

/**
 * Child process management for agent runs and check commands.
 *
 * A command started through a shell is a tree (sh or cmd.exe, then the real program).
 * Signalling only the shell leaves the program running with the output pipes open, so
 * the run would hang forever. We therefore kill the whole tree:
 *  - POSIX: children start in their own process group and the group is signalled.
 *  - Windows: `taskkill /T /F` ends the tree.
 * Because a separate process group no longer receives the terminal's Ctrl-C, live
 * children are tracked and killed if this process exits or is interrupted.
 */
const live = new Set<ChildProcess>();
let hooked = false;

function killAll(): void {
  for (const c of live) killGroup(c, 'SIGKILL');
}

function hook(): void {
  if (hooked) return;
  hooked = true;
  process.on('exit', killAll);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      killAll();
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * `spawn` that registers the child for tree-kill and cleanup. Never use a bare spawn for
 * agent or check runs. Callers must pipe stdout and stderr (stdin may be piped or ignored).
 */
export function spawnManaged(command: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams {
  hook();
  const child = spawn(command, args, { ...options, detached: process.platform !== 'win32' });
  live.add(child);
  child.once('close', () => live.delete(child));
  child.once('error', () => live.delete(child));
  return child as ChildProcessWithoutNullStreams;
}

/** Terminate a managed child and everything it started. */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  killGroup(child, 'SIGTERM');
  if (process.platform !== 'win32') {
    setTimeout(() => {
      if (child.exitCode === null) killGroup(child, 'SIGKILL');
    }, 2000).unref();
  }
}
