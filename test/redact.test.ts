import { describe, expect, it } from 'vitest';
import { clip, redactString, redactValue, REDACTED } from '../src/redact/redact.js';

describe('redactString', () => {
  const cases: Array<[string, string, string]> = [
    ['anthropic key', 'key is sk-ant-api03-abcdefghijkl', 'sk-ant-'],
    ['openai-style key', 'use sk-abcdefghijklmnopqrstuvwx', 'sk-abcdef'],
    ['github token', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_abc'],
    ['aws key', 'AKIAABCDEFGHIJKLMNOP is it', 'AKIAABCDEF'],
    ['bearer header', 'Authorization: Bearer abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['jwt', 'tok eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghijkl123', 'eyJhbGci'],
    ['env assignment', 'DATABASE_PASSWORD=hunter2 node app.js', 'hunter2'],
    ['quoted env assignment', 'export API_TOKEN="a b c"', 'a b c'],
    ['url creds', 'git clone https://bob:s3cret@github.com/x/y', 's3cret'],
    ['json secret field', '{"apiKey": "abc123", "ok": 1}', 'abc123'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----', 'MIIB'],
    ['windows home', 'C:\\Users\\alice\\project\\x.ts', 'alice'],
    ['posix home', '/home/alice/project/x.ts', 'alice'],
  ];
  it.each(cases)('%s', (_n, input, mustNotContain) => {
    expect(redactString(input)).not.toContain(mustNotContain);
  });

  it('leaves ordinary text alone', () => {
    const s = 'Run pnpm test in src/lib and fix the parser';
    expect(redactString(s)).toBe(s);
  });
  it('keeps the variable name for env assignments', () => {
    expect(redactString('API_KEY=abc')).toBe(`API_KEY=${REDACTED}`);
  });
});

describe('redactValue', () => {
  it('redacts values under secret-looking keys and nested strings', () => {
    const out = redactValue({
      file_path: 'src/a.ts',
      headers: { Authorization: 'Bearer xyz', Accept: 'json' },
      list: ['ok', 'TOKEN=abcdef'],
      n: 3,
    });
    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.headers.Accept).toBe('json');
    expect(out.list[1]).toBe(`TOKEN=${REDACTED}`);
    expect(out.file_path).toBe('src/a.ts');
    expect(out.n).toBe(3);
  });
  it('does not mutate its input', () => {
    const input = { password: 'p' };
    redactValue(input);
    expect(input.password).toBe('p');
  });
});

describe('clip', () => {
  it('truncates with a marker', () => {
    expect(clip('abcdef', 3)).toBe('abc… [+3 chars]');
    expect(clip('abc', 3)).toBe('abc');
  });
});
