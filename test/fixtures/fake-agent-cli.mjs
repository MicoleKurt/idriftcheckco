// Stand-in for an agent CLI. Mode is the first argument:
//   ok | auth-fail | hang | logged-out | auth-garbage
// Handles `--version` and `auth status` like the real CLI; otherwise reads the task from
// stdin, prints stream-json and exits.
import { readFileSync } from 'node:fs';

const [mode, ...rest] = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (rest.includes('--version')) {
  process.stdout.write('9.9.9 (stand-in agent)\n');
  process.exit(0);
}
if (rest[0] === 'auth' && rest[1] === 'status') {
  if (mode === 'auth-garbage') process.stdout.write('not json at all\n');
  else out({ loggedIn: mode !== 'logged-out', authMethod: mode === 'logged-out' ? 'none' : 'oauth' });
  process.exit(0);
}

const task = readFileSync(0, 'utf8');
if (mode === 'hang') {
  setInterval(() => undefined, 1000);
} else if (mode === 'auth-fail') {
  out({ type: 'assistant', message: { id: 'm1', model: '<synthetic>', content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }] }, isApiErrorMessage: true });
  out({ type: 'result', subtype: 'error', is_error: true, total_cost_usd: 0 });
  process.exit(1);
} else {
  out({ type: 'system', subtype: 'init' });
  out({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-4-8', content: [{ type: 'text', text: `got ${task.length} chars` }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo ok' } }], usage: { input_tokens: 10, output_tokens: 5 } } });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  out({ type: 'assistant', message: { id: 'm2', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 20, output_tokens: 5 } } });
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0123 });
}
