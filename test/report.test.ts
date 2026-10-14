import { describe, expect, it } from 'vitest';
import { diffGroups } from '../src/diff/diff.js';
import { badgeEndpoint, renderJson, toCiResult } from '../src/report/json.js';
import { COMMENT_MARKER, renderMarkdown } from '../src/report/markdown.js';
import { renderTerminal, summaryLine } from '../src/report/terminal.js';
import { stripAnsi } from '../src/util/format.js';
import { FIX_AND_TEST, many } from './helpers.js';

const regression = () =>
  diffGroups(
    many(4, { calls: FIX_AND_TEST, costUsd: 0.1, variant: 'opus-4-8', model: 'claude-opus-4-8' }),
    many(4, { calls: [['Read', 'src/a.ts'], ['Bash', 'pnpm test']], costUsd: 0.3, variant: 'opus-5-5', model: 'claude-opus-5-5' }),
  );
const stable = () => diffGroups(many(4, { calls: FIX_AND_TEST }), many(4, { calls: FIX_AND_TEST }));

describe('renderTerminal', () => {
  it('shows verdict, both sides and the finding (no color)', () => {
    const out = renderTerminal(regression(), { color: false });
    expect(out).toContain('REGRESSION');
    expect(out).toContain('opus-4-8 [claude-opus-4-8] (4 runs)');
    expect(out).toContain('No longer changes src/a.ts');
    expect(out).toContain('p=0.029');
    expect(out).toContain('HARD');
    expect(out).toContain('SOFT');
    expect(out).not.toContain('\u001b[');
  });
  it('emits ANSI only when color is on, and stripping it gives the plain text', () => {
    const r = regression();
    const colored = renderTerminal(r, { color: true });
    expect(colored).toContain('\u001b[');
    expect(stripAnsi(colored)).toBe(renderTerminal(r, { color: false }));
  });
  it('says so when there is nothing to report', () => {
    const out = renderTerminal(stable());
    expect(out).toContain('NO CHANGE');
    expect(out).toContain('Nothing to report');
  });
  it('marks weak evidence as unconfirmed', () => {
    const r = diffGroups(many(1, { calls: FIX_AND_TEST }), many(1, { calls: [['Bash', 'pnpm test']] }));
    expect(renderTerminal(r)).toContain('unconfirmed');
  });
  it('supports ASCII glyphs', () => {
    const out = renderTerminal(regression(), { ascii: true });
    expect(out).not.toMatch(/[✖▲▼●⚠▸]/);
  });
  it('builds a one-line summary', () => {
    expect(summaryLine(regression())).toMatch(/^REGRESSION: \d+ hard, \d+ soft findings? \(4 vs 4 runs\)/);
  });
});

describe('renderMarkdown', () => {
  it('starts with the marker used to update an existing PR comment', () => {
    expect(renderMarkdown(regression()).startsWith(COMMENT_MARKER)).toBe(true);
  });
  it('includes findings, a metrics table and an optional link', () => {
    const md = renderMarkdown(regression(), { reportUrl: 'https://example.com/r.html' });
    expect(md).toContain('Hard regressions');
    expect(md).toContain('| Metric | Baseline | Candidate | Change | p |');
    expect(md).toContain('[Full report](https://example.com/r.html)');
  });
  it('stays quiet for a stable result', () => {
    const md = renderMarkdown(stable());
    expect(md).toContain('NO CHANGE');
    expect(md).not.toContain('Hard regressions');
  });
});

describe('renderJson / toCiResult / badge', () => {
  it('round-trips and carries the exit code', () => {
    const parsed = JSON.parse(renderJson(regression()));
    expect(parsed.verdict).toBe('regression');
    expect(parsed.exitCode).toBe(1);
    expect(parsed.counts.hard).toBeGreaterThan(0);
    expect(parsed.report.schemaVersion).toBe(1);
  });
  it('failOn=drift fails on soft drift', () => {
    const drift = diffGroups(many(4, { calls: FIX_AND_TEST, costUsd: 0.1 }), many(4, { calls: FIX_AND_TEST, costUsd: 0.3 }));
    expect(toCiResult(drift, 'regression').exitCode).toBe(0);
    expect(toCiResult(drift, 'drift').exitCode).toBe(1);
  });
  it('produces a shields.io endpoint payload', () => {
    expect(badgeEndpoint(stable())).toEqual({ schemaVersion: 1, label: 'agent drift', message: 'stable', color: 'brightgreen' });
    expect(badgeEndpoint(regression()).color).toBe('red');
  });
});
