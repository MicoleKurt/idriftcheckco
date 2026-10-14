import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { alignMilestones } from '../src/diff/milestones.js';
import { diffGroups } from '../src/diff/diff.js';
import { renderHtml } from '../src/report/html.js';
import { VERSION } from '../src/version.js';
import { FIX_AND_TEST, many } from './helpers.js';

const make = () => {
  const baseline = many(4, { calls: FIX_AND_TEST, costUsd: 0.1, variant: 'opus-4-8', model: 'claude-opus-4-8' });
  const candidate = many(4, {
    calls: [['Read', 'src/a.ts'], ['Bash', 'pnpm test']],
    costUsd: 0.3,
    variant: 'opus-5-5',
    model: 'claude-opus-5-5',
  });
  const report = diffGroups(baseline, candidate);
  return { baseline, candidate, report, html: renderHtml(report, { baseline, candidate, generatedAt: '2026-01-01T00:00:00Z' }) };
};

describe('renderHtml', () => {
  it('is a complete document with verdict, findings, metrics, timeline and runs', () => {
    const { html } = make();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('REGRESSION');
    expect(html).toContain('No longer changes src/a.ts');
    expect(html).toContain('class="strip"');
    expect(html).toContain('class="tl"');
    expect(html).toContain('opus-5-5: 4 runs');
  });

  it('is self-contained: no scripts, external stylesheets, fonts or network URLs', () => {
    const { html } = make();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/(src|href)=["']https?:/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
  });

  it('escapes untrusted strings from traces', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const baseline = many(2, { calls: [['Edit', evil]], variant: evil });
    const candidate = many(2, { calls: [['Edit', 'ok.ts']] });
    const html = renderHtml(diffGroups(baseline, candidate), { baseline, candidate });
    expect(html).not.toContain(evil);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('is deterministic for a fixed timestamp', () => {
    const a = make();
    expect(renderHtml(a.report, { baseline: a.baseline, candidate: a.candidate, generatedAt: 'x' })).toBe(
      renderHtml(a.report, { baseline: a.baseline, candidate: a.candidate, generatedAt: 'x' }),
    );
  });

  it('renders a calm report when nothing changed', () => {
    const baseline = many(3, { calls: FIX_AND_TEST });
    const candidate = many(3, { calls: FIX_AND_TEST });
    const html = renderHtml(diffGroups(baseline, candidate), { baseline, candidate });
    expect(html).toContain('NO CHANGE');
    expect(html).toContain('None: same files');
  });

  it('supports dark mode via prefers-color-scheme', () => {
    expect(make().html).toContain('prefers-color-scheme:dark');
  });
});

describe('alignMilestones', () => {
  it.each([
    [['a', 'b', 'c'], ['a', 'c'], ['same:a', 'removed:b', 'same:c']],
    [['a'], ['b'], ['removed:a', 'added:b']],
    [[], ['x'], ['added:x']],
    [['x'], [], ['removed:x']],
    [['a', 'b'], ['a', 'b'], ['same:a', 'same:b']],
  ])('%j vs %j', (a, b, expected) => {
    expect(alignMilestones(a, b).map((o) => `${o.op}:${o.value}`)).toEqual(expected);
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
