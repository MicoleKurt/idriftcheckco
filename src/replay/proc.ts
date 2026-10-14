import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Terminate a child and everything it started. On Windows a command spawned through a
 * shell is a tree (cmd.exe -> the real program), and `child.kill()` only ends the shell,
 * leaving the program running and its pipes open, so the run would hang forever.
 */
export function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    return;
  }
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 2000).unref();
}
