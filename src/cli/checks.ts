import type { AgentRunner, Check } from '../replay/runner.js';
import type { Ctx } from './context.js';

/** Render checks as a compact ✓ / ! / ✗ list, with the fix under anything that is not ok. */
export function renderChecks(checks: Check[], color: boolean): string {
  const paint = (s: string, code: number) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const icon = { ok: paint('✓', 32), warn: paint('!', 33), fail: paint('✗', 31) } as const;
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines = [''];
  for (const c of checks) {
    lines.push(`  ${icon[c.status]} ${c.name.padEnd(width)}  ${c.detail}`);
    if (c.fix && c.status !== 'ok') lines.push(paint(`    ${' '.repeat(width)}  → ${c.fix}`, 90));
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Run the runner's free pre-flight before a paid run. Failures stop the run with the
 * fixes listed, before anything is spent; in a dry run they are shown as a heads-up.
 */
export async function preflightOrThrow(ctx: Ctx, runner: AgentRunner, dryRun: boolean): Promise<void> {
  if (!runner.paid || !runner.preflight) return;
  const checks = await runner.preflight(ctx.cwd);
  const bad = checks.filter((c) => c.status !== 'ok');
  if (bad.length === 0) return;
  ctx.stderr(renderChecks(bad, ctx.color));
  const failed = bad.filter((c) => c.status === 'fail');
  if (failed.length === 0) return;
  if (dryRun) {
    ctx.stderr(' Heads-up: a real run would fail until the problem above is fixed.');
    return;
  }
  throw new Error(
    `Not starting: ${failed.map((c) => c.detail).join('; ')}. Nothing was spent. Run \`idriftcheckco doctor\` after fixing.`,
  );
}
