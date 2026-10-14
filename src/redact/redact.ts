/**
 * Redaction is applied at the point data enters the system (import / replay), so
 * nothing sensitive is ever written to `.idriftcheckco/`. It is pattern based and
 * therefore best-effort: review reports before sharing them publicly.
 */

export const REDACTED = '[REDACTED]';

interface Rule {
  name: string;
  re: RegExp;
  replace: string | ((substring: string, ...groups: string[]) => string);
}

const RULES: Rule[] = [
  {
    name: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: REDACTED,
  },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g, replace: REDACTED },
  { name: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}/g, replace: REDACTED },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}/g, replace: REDACTED },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: REDACTED,
  },
  {
    name: 'auth-header',
    re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: (_m, scheme) => `${scheme} ${REDACTED}`,
  },
  {
    name: 'url-credentials',
    re: /\/\/([^\s:@/]+):([^\s@/]+)@/g,
    replace: (_m, user) => `//${user}:${REDACTED}@`,
  },
  {
    name: 'json-secret-field',
    re: /("[\w-]*(?:key|token|secret|password|passwd|authorization|credential|cookie)[\w-]*"\s*:\s*)"[^"]*"/gi,
    replace: (_m, prefix) => `${prefix}"${REDACTED}"`,
  },
  {
    name: 'env-assignment',
    re: /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"']+)/gi,
    replace: (_m, name) => `${name}=${REDACTED}`,
  },
  {
    // Home directories leak usernames into shareable reports.
    name: 'home-dir',
    re: /(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\s"']+/g,
    replace: '~',
  },
];

const SECRET_KEY = /(key|token|secret|password|passwd|authorization|credential|cookie)/i;

/** Redact secrets and home-directory paths in free text. */
export function redactString(input: string): string {
  let out = input;
  for (const rule of RULES) {
    out = out.replace(rule.re, rule.replace as never);
  }
  return out;
}

/** Deeply redact a JSON-like value. Values under secret-looking keys are replaced wholesale. */
export function redactValue<T>(value: T): T {
  return walk(value, 0) as T;
}

function walk(value: unknown, depth: number): unknown {
  if (depth > 12) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? REDACTED : walk(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Truncate with an ellipsis marker; applied after redaction so secrets never straddle the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [+${text.length - max} chars]`;
}
