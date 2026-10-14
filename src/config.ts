import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DEFAULT_STORE_DIR } from './store/store.js';

const PriceSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});

/** Everything is optional: idriftcheckco works with zero config. */
export const ConfigSchema = z
  .object({
    /** Command run in the replay worktree after the agent finishes, e.g. `pnpm test`. Exit 0 = pass. */
    check: z.string().optional(),
    /** Replays per arm. 3 is cheap; 4+ allows statistically significant verdicts. */
    runs: z.number().int().min(1).max(50).default(3),
    alpha: z.number().gt(0).lt(1).default(0.05),
    /** Smallest relative change in cost/steps/tokens/time worth reporting. */
    softThreshold: z.number().gt(0).default(0.25),
    /** Agent CLI executable. */
    claudeBin: z.string().default('claude'),
    /** Arguments placed before idriftcheckco's own, for wrappers (e.g. claudeBin "npx", claudeArgs ["claude"]). */
    claudeArgs: z.array(z.string()).default([]),
    permissionMode: z.enum(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']).default('acceptEdits'),
    /**
     * Tools replays may use without asking. "session" (default): the tools the original
     * session used, so a replay can run the same commands. "none": leave it to permissionMode.
     */
    allowedTools: z.union([z.enum(['session', 'none']), z.array(z.string())]).default('session'),
    /** Replay only the first prompt (default, cheaper) or every human turn of the session. */
    turns: z.enum(['first', 'all']).default('first'),
    timeoutMinutes: z.number().positive().default(15),
    /** Hard spending cap per `replay`/`ci` invocation. */
    maxCostUsd: z.number().positive().optional(),
    /** Extra environment variable NAMES to pass to the agent (everything else is withheld). */
    env: z.array(z.string()).default([]),
    /** Per-model price overrides in USD per million tokens. */
    prices: z.record(z.string(), PriceSchema).optional(),
    /** Trace ids replayed by `idriftcheckco ci`. Empty means all stored traces. */
    suite: z.array(z.string()).default([]),
    storeDir: z.string().default(DEFAULT_STORE_DIR),
    /** Where session transcripts live. Defaults to $CLAUDE_CONFIG_DIR or ~/.claude. */
    sessionsDir: z.string().optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

/** Identity helper that gives `idriftcheckco.config.ts` full type checking. */
export function defineConfig(config: ConfigInput): ConfigInput {
  return config;
}

const CANDIDATES = ['idriftcheckco.config.ts', 'idriftcheckco.config.mjs', 'idriftcheckco.config.js', 'idriftcheckco.config.json'];

export function parseConfig(raw: unknown, origin = 'config'): Config {
  const res = ConfigSchema.safeParse(raw);
  if (!res.success) {
    const i = res.error.issues[0];
    throw new Error(
      `Invalid ${origin}: ${i?.path.join('.') || '(root)'}: ${i?.message ?? 'invalid'}. See the "Configuration" section of the README for valid options.`,
    );
  }
  return res.data;
}

/** Load `idriftcheckco.config.*` from `cwd`, or defaults when none exists. */
export async function loadConfig(cwd: string): Promise<{ config: Config; path?: string }> {
  for (const name of CANDIDATES) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    let raw: unknown;
    if (name.endsWith('.json')) {
      try {
        raw = JSON.parse(await readFile(path, 'utf8'));
      } catch (e) {
        throw new Error(`${name} is not valid JSON: ${(e as Error).message}`, { cause: e });
      }
    } else {
      try {
        const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
        raw = mod.default ?? mod;
      } catch (e) {
        const hint = name.endsWith('.ts')
          ? ' TypeScript configs need Node 22.18+; on older Node use idriftcheckco.config.mjs or .json.'
          : '';
        throw new Error(`Could not load ${name}: ${(e as Error).message}.${hint}`, { cause: e });
      }
    }
    return { config: parseConfig(raw, name), path };
  }
  return { config: parseConfig({}) };
}
