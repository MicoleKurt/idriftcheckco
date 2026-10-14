import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEMO_REPO, DEMO_SCENARIO, demoSource } from '../src/demo.js';
import { parseScenario } from '../src/replay/fake-runner.js';
import { parseTrace } from '../src/trace/schema.js';

const read = (p: string) => readFileSync(new URL(`../examples/regression-demo/${p}`, import.meta.url), 'utf8');

describe('examples/regression-demo stays in sync with the built-in demo', () => {
  it('scenario.json matches DEMO_SCENARIO', () => {
    expect(parseScenario(JSON.parse(read('scenario.json')))).toEqual(DEMO_SCENARIO);
  });
  it('trace.json is a valid trace equal to the demo source', () => {
    expect(parseTrace(JSON.parse(read('trace.json')))).toEqual(demoSource());
  });
  it('repo files match DEMO_REPO', () => {
    for (const [path, content] of Object.entries(DEMO_REPO)) {
      expect(read(`repo/${path}`).replace(/\r\n/g, '\n')).toBe(content);
    }
  });
});
