import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, parseConfig } from '../src/config.js';
import { loadTraceDir, Store, slug, type RunMeta } from '../src/store/store.js';
import { many, mk } from './helpers.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idc-store-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Store', () => {
  it('round-trips a trace and resolves it by id, prefix and path', async () => {
    const s = new Store(dir);
    const t = mk({ id: 'abcdef123456' });
    const path = await s.saveTrace(t);
    expect(await s.resolveTrace('abcdef123456')).toEqual(t);
    expect(await s.resolveTrace('abcd')).toEqual(t);
    expect(await s.resolveTrace(path)).toEqual(t);
  });

  it('reports ambiguous prefixes and unknown ids helpfully', async () => {
    const s = new Store(dir);
    await s.saveTrace(mk({ id: 'aaa111' }));
    await s.saveTrace(mk({ id: 'aaa222' }));
    await expect(s.resolveTrace('aaa')).rejects.toThrow(/matches 2 traces/);
    await expect(s.resolveTrace('zzz')).rejects.toThrow(/idriftcheckco import/);
  });

  it('writes stable, git-friendly JSON (indented, trailing newline)', async () => {
    const s = new Store(dir);
    const path = await s.saveTrace(mk({ id: 'x1' }));
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(path, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "schemaVersion": 1');
  });

  it('stores runs per arm and reloads them in order', async () => {
    const s = new Store(dir);
    const meta: RunMeta = {
      schemaVersion: 1, runId: 'r1', createdAt: 'now', task: 't', runner: 'fake', runsPerArm: 2,
      arms: [{ name: 'control', variant: { name: 'control' } }, { name: 'new model', variant: { name: 'new model' } }], notes: [],
    };
    await s.saveRunMeta(meta);
    for (const [i, t] of many(2).entries()) await s.saveRunTrace('r1', 'control', i, t);
    for (const [i, t] of many(2).entries()) await s.saveRunTrace('r1', 'new model', i, t);
    const run = await s.loadRun('r1');
    expect(run.arms['control']).toHaveLength(2);
    expect(run.arms['new model']).toHaveLength(2);
    expect((await s.loadRun('latest')).meta.runId).toBe('r1');
  });

  it('explains what to do when there are no runs', async () => {
    await expect(new Store(dir).loadRun('latest')).rejects.toThrow(/No runs yet/);
  });

  it('rejects a corrupt trace with a fix-it message', async () => {
    const s = new Store(dir);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"schemaVersion":1}');
    await expect(s.loadTraceFile(bad)).rejects.toThrow(/Invalid .*idriftcheckco import/s);
    writeFileSync(bad, 'not json');
    await expect(s.loadTraceFile(bad)).rejects.toThrow(/not valid JSON/);
  });

  it('loadTraceDir reads every trace and ignores meta.json', async () => {
    const s = new Store(dir);
    await s.saveTrace(mk({ id: 'a' }));
    await s.saveTrace(mk({ id: 'b' }));
    writeFileSync(join(s.tracesDir, 'meta.json'), '{}');
    expect(await loadTraceDir(s.tracesDir)).toHaveLength(2);
  });

  it('slug is filesystem-safe', () => {
    expect(slug('Opus 4.8 / new!')).toBe('opus-4.8-new');
    expect(slug('///')).toBe('x');
  });
});

describe('config', () => {
  it('has working defaults with zero config', () => {
    const c = parseConfig({});
    expect(c.runs).toBe(3);
    expect(c.alpha).toBe(0.05);
    expect(c.permissionMode).toBe('acceptEdits');
    expect(c.storeDir).toBe('.idriftcheckco');
  });
  it.each([
    [{ runs: 0 }, /runs/],
    [{ alpha: 2 }, /alpha/],
    [{ bogus: 1 }, /bogus|Unrecognized/],
    [{ permissionMode: 'wild' }, /permissionMode/],
  ])('rejects %j', (input, re) => {
    expect(() => parseConfig(input)).toThrow(re);
  });
  it('loads idriftcheckco.config.json from a directory', async () => {
    writeFileSync(join(dir, 'idriftcheckco.config.json'), JSON.stringify({ check: 'pnpm test', runs: 5 }));
    const { config, path } = await loadConfig(dir);
    expect(config.check).toBe('pnpm test');
    expect(config.runs).toBe(5);
    expect(path).toMatch(/idriftcheckco\.config\.json$/);
  });
  it('loads an .mjs config', async () => {
    writeFileSync(join(dir, 'idriftcheckco.config.mjs'), 'export default { runs: 4 };\n');
    expect((await loadConfig(dir)).config.runs).toBe(4);
  });
  it('returns defaults when there is no config file', async () => {
    const r = await loadConfig(dir);
    expect(r.path).toBeUndefined();
    expect(r.config.runs).toBe(3);
  });
  it('names the file and the problem on invalid JSON', async () => {
    writeFileSync(join(dir, 'idriftcheckco.config.json'), '{oops');
    await expect(loadConfig(dir)).rejects.toThrow(/idriftcheckco\.config\.json is not valid JSON/);
  });
});
