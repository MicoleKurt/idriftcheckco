import { describe, expect, it } from 'vitest';
import {
  categorize,
  commandSignature,
  isVerificationCommand,
  normalizePath,
  targetOf,
} from '../src/trace/classify.js';

describe('categorize', () => {
  it.each([
    ['Read', 'read'],
    ['Edit', 'write'],
    ['Write', 'write'],
    ['Grep', 'search'],
    ['Bash', 'exec'],
    ['PowerShell', 'exec'],
    ['mcp__github__create_issue', 'mcp'],
    ['Agent', 'agent'],
    ['WebFetch', 'web'],
    ['TodoWrite', 'other'],
  ] as const)('%s -> %s', (name, cat) => {
    expect(categorize(name)).toBe(cat);
  });
});

describe('normalizePath', () => {
  it('makes paths under cwd relative, case-insensitively on the prefix', () => {
    expect(normalizePath('C:\\Users\\dev\\app\\src\\a.ts', 'c:\\users\\dev\\app')).toBe('src/a.ts');
  });
  it('keeps paths outside cwd', () => {
    expect(normalizePath('/etc/hosts', '/home/x')).toBe('/etc/hosts');
  });
  it('does not treat a sibling with a shared prefix as inside cwd', () => {
    expect(normalizePath('/home/x/app2/a.ts', '/home/x/app')).toBe('/home/x/app2/a.ts');
  });
});

describe('targetOf', () => {
  it('uses file_path for writes and first command line for exec', () => {
    expect(targetOf('Edit', 'write', { file_path: '/p/a.ts' }, '/p')).toBe('a.ts');
    expect(targetOf('Bash', 'exec', { command: 'pnpm test\nsecond' })).toBe('pnpm test');
  });
});

describe('commandSignature', () => {
  it.each([
    ['cd app && pnpm run test -- foo', 'pnpm run test'],
    ['git status -s', 'git status'],
    ['NODE_ENV=test vitest run', 'vitest run'],
    ['pnpm test', 'pnpm test'],
    ['npm run build && echo done', 'echo done'],
  ])('%s -> %s', (cmd, sig) => {
    expect(commandSignature(cmd)).toBe(sig);
  });
});

describe('isVerificationCommand', () => {
  it.each([
    ['pnpm test', true],
    ['npx vitest run', true],
    ['cd x && tsc --noEmit', true],
    ['pnpm run lint', true],
    ['git commit -m "fix tests"', false],
    ['ls -la', false],
  ])('%s -> %s', (cmd, expected) => {
    expect(isVerificationCommand(cmd)).toBe(expected);
  });
});
