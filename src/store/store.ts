import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { parseTrace, VariantSchema, type Trace } from '../trace/schema.js';

export const DEFAULT_STORE_DIR = '.idriftcheckco';

export const RunMetaSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  createdAt: z.string(),
  /** Id of the imported trace whose task was replayed. */
  sourceTraceId: z.string().optional(),
  task: z.string(),
  ref: z.string().optional(),
  runner: z.string(),
  runsPerArm: z.number().int().positive(),
  /** Arm names in comparison order: first is the baseline, last the candidate. */
  arms: z.array(z.object({ name: z.string(), variant: VariantSchema })),
  notes: z.array(z.string()).default([]),
});
export type RunMeta = z.infer<typeof RunMetaSchema>;

/** Filesystem-safe slug. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Stable, git-friendly JSON: 2-space indent, trailing newline, written atomically. */
async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Cannot read ${path}. Check the path, or run \`idriftcheckco scan\` to see what is available.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON. Re-create it with \`idriftcheckco import\`.`);
  }
}

/**
 * Plain-JSON store under `.idriftcheckco/`:
 *
 *   traces/<id>.json                  imported sessions (baselines)
 *   runs/<runId>/meta.json            what was replayed and how
 *   runs/<runId>/<arm>/<n>.json       one trace per replay run
 *   reports/                          generated HTML reports
 */
export class Store {
  readonly root: string;
  constructor(cwd: string, dir = DEFAULT_STORE_DIR) {
    this.root = resolve(cwd, dir);
  }

  get tracesDir(): string {
    return join(this.root, 'traces');
  }
  get runsDir(): string {
    return join(this.root, 'runs');
  }
  get reportsDir(): string {
    return join(this.root, 'reports');
  }

  async saveTrace(trace: Trace): Promise<string> {
    await mkdir(this.tracesDir, { recursive: true });
    const path = join(this.tracesDir, `${slug(trace.id)}.json`);
    await writeJson(path, trace);
    return path;
  }

  async loadTraceFile(path: string): Promise<Trace> {
    return parseTrace(await readJson(path), path);
  }

  async listTraces(): Promise<Trace[]> {
    if (!(await exists(this.tracesDir))) return [];
    const files = (await readdir(this.tracesDir)).filter((f) => f.endsWith('.json')).sort();
    return Promise.all(files.map((f) => this.loadTraceFile(join(this.tracesDir, f))));
  }

  /** Resolve an id, id prefix, or file path to a stored trace. */
  async resolveTrace(ref: string): Promise<Trace> {
    if (await exists(ref)) return this.loadTraceFile(ref);
    const all = await this.listTraces();
    const exact = all.find((t) => t.id === ref);
    if (exact) return exact;
    const prefix = all.filter((t) => t.id.startsWith(ref));
    if (prefix.length === 1) return prefix[0]!;
    if (prefix.length > 1) {
      throw new Error(`"${ref}" matches ${prefix.length} traces (${prefix.map((t) => t.id).join(', ')}). Use more characters.`);
    }
    throw new Error(
      `No trace "${ref}" in ${this.tracesDir}. Run \`idriftcheckco import\` first, or pass a path to a trace file.`,
    );
  }

  runDir(runId: string): string {
    return join(this.runsDir, slug(runId));
  }

  async saveRunMeta(meta: RunMeta): Promise<void> {
    await mkdir(this.runDir(meta.runId), { recursive: true });
    await writeJson(join(this.runDir(meta.runId), 'meta.json'), meta);
  }

  async saveRunTrace(runId: string, arm: string, index: number, trace: Trace): Promise<string> {
    const dir = join(this.runDir(runId), slug(arm));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${String(index + 1).padStart(2, '0')}.json`);
    await writeJson(path, trace);
    return path;
  }

  async loadRun(runId: string): Promise<{ meta: RunMeta; arms: Record<string, Trace[]> }> {
    const id = runId === 'latest' ? await this.latestRunId() : runId;
    const dir = this.runDir(id);
    if (!(await exists(dir))) {
      throw new Error(`No run "${runId}" in ${this.runsDir}. List runs with \`ls ${this.runsDir}\` or start one with \`idriftcheckco replay\`.`);
    }
    const parsed = RunMetaSchema.safeParse(await readJson(join(dir, 'meta.json')));
    if (!parsed.success) throw new Error(`Run ${id} has an unreadable meta.json (${parsed.error.issues[0]?.message}).`);
    const meta = parsed.data;
    const arms: Record<string, Trace[]> = {};
    for (const arm of meta.arms) {
      const armDir = join(dir, slug(arm.name));
      const files = (await exists(armDir)) ? (await readdir(armDir)).filter((f) => f.endsWith('.json')).sort() : [];
      arms[arm.name] = await Promise.all(files.map((f) => this.loadTraceFile(join(armDir, f))));
    }
    return { meta, arms };
  }

  async listRunIds(): Promise<string[]> {
    if (!(await exists(this.runsDir))) return [];
    const ids = await readdir(this.runsDir);
    const dated: Array<[string, number]> = [];
    for (const id of ids) {
      const m = join(this.runsDir, id, 'meta.json');
      if (await exists(m)) dated.push([id, (await stat(m)).mtimeMs]);
    }
    return dated.sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  async latestRunId(): Promise<string> {
    const ids = await this.listRunIds();
    if (ids.length === 0) throw new Error('No runs yet. Start one with `idriftcheckco replay <trace> --model <model>`.');
    return ids[0]!;
  }

  async writeReport(name: string, html: string): Promise<string> {
    await mkdir(this.reportsDir, { recursive: true });
    const path = join(this.reportsDir, `${slug(name)}.html`);
    await writeFile(path, html, 'utf8');
    return path;
  }
}

/** Load every `*.json` trace directly inside a directory. */
export async function loadTraceDir(dir: string): Promise<Trace[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'meta.json').sort();
  if (files.length === 0) throw new Error(`${dir} contains no trace .json files.`);
  return Promise.all(files.map(async (f) => parseTrace(await readJson(join(dir, f)), join(dir, f))));
}
