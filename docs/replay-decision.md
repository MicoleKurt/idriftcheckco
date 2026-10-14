# Replay decision: how a session is re-run

Source: `claude --help` (v2.1.252 on this machine) plus the transcript survey.

## Capabilities that exist today

- `claude -p/--print` non-interactive; `--output-format json|stream-json`;
  `--input-format stream-json`.
- `--model`, `--effort`, `--permission-mode`, `--allowedTools/--disallowedTools`.
- Variant knobs map 1:1 to our variant types: `--model` (model), `--system-prompt[-file]` /
  `--append-system-prompt[-file]` (prompt), `--mcp-config` + `--strict-mcp-config` (MCP),
  `--settings`, `--setting-sources` (CLAUDE.md via the worktree's own file),
  `--add-dir`, `--agents`, `--plugin-dir`.
- Isolation/safety: `--no-session-persistence`, `--session-id <uuid>`, `--max-budget-usd`,
  `--bare` (skips hooks/CLAUDE.md discovery/keychain; API-key auth only).
- Cost-capped runs via `--max-budget-usd` give us a hard guard for `--dry-run` follow-through.

## Decision

Replay = **re-run the task, not re-feed the transcript.** For each variant × N runs:
1. `git worktree add` a temp worktree at the commit the original session started from
   (`gitBranch`/`cwd` in the transcript; fall back to current HEAD with a warning).
2. Spawn `claude -p "<first user prompt>" --output-format stream-json --verbose` in the
   worktree with the variant's flags. Env is allow-listed; user's real repo is untouched.
3. Parse the resulting stream/transcript through the *same adapter* → Trace.
4. Collect `git diff` of the worktree as ground-truth "files changed".
5. Optional hard-signal command (`test` in config, e.g. `pnpm test`) run after the agent.

The agent runner is an interface (`AgentRunner`). Implementations: `ClaudeCodeRunner`,
and `FakeRunner` (deterministic scripted agent) used by the e2e test so CI needs no key.

## Limits (to be stated in the README)

- Multi-turn sessions: v0.1 replays only the **initial task** (per the brief). Follow-up
  human turns are not simulated.
- Non-determinism: single runs prove nothing; N≥3 with variance is the default.
- External state (network, databases, MCP side effects) is not reproduced.
- Paid: each replay is a real API run. `--dry-run` estimates from the original trace's
  token profile × target model price table (an estimate, with the margin shown).
- Subscription (OAuth) vs API-key auth: `--bare` needs an API key; non-bare runs inherit
  the user's login. Documented, user's choice.
- Hooks/plugins/CLAUDE.md of the user machine can leak into replay unless `--bare` or
  `--setting-sources` is pinned; the variant must record which were active.
