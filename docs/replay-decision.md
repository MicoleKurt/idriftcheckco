# Replay decision: how a session is re-run

Source: `claude --help` (v2.1.252 on the author's machine) and the transcript survey.

## Capabilities that exist today

- `-p/--print` non-interactive mode; `--output-format json|stream-json`;
  `--input-format stream-json`.
- Variant knobs map onto our variant types: `--model` (model), `--mcp-config` +
  `--strict-mcp-config` (MCP), `--permission-mode`, `--add-dir`, `--settings`,
  `--setting-sources`, `--agents`, `--plugin-dir`.
- Safety and cost: `--no-session-persistence`, `--max-budget-usd`, `--session-id`,
  `--bare` (skips hooks / project instructions discovery; API-key auth only).

## Decision

Replay **re-runs the task; it does not re-feed the transcript.** For each arm and each of
N runs:

1. `git worktree add --detach` a temp worktree at `--ref` (default `HEAD`).
2. Copy any variant overlay files into it (e.g. an edited `CLAUDE.md`).
3. Spawn the agent CLI with `-p --output-format stream-json --verbose
   --no-session-persistence --permission-mode <mode>` plus the variant's flags. The **task is
   written to stdin**, not passed as an argument, to avoid shell-quoting hazards (the
   Windows shim is a `.cmd` file and needs a shell) and argument-length limits. Every
   argument we do pass is validated against a strict character allow-list.
4. Parse the stream with the same adapter used for stored sessions, which yields a Trace.
5. Replace "files changed" with `git status` of the worktree (ground truth), run the
   optional check command there, then remove the worktree (also on failure).

The runner is an interface (`AgentRunner`): `ClaudeCodeRunner` for real runs and
`FakeRunner` (a deterministic script that really edits files) for tests and the demo.

## Environment isolation

The agent receives an allow-listed environment: what it needs to start and authenticate
(PATH, home, temp, model-provider credentials) plus any names the user lists under `env`.
Cloud and CI secrets are withheld so they cannot enter the model's context.

## What was verified and what was not

- **Verified:** the CLI flags above exist (`--help`); the adapter handles message,
  tool_use and tool_result shapes from 79 real stored sessions; the pipeline works end
  to end with the fake runner (CI).
- **Not verified by an automated test:** the exact `stream-json` event shapes emitted by
  a live paid run, and reading the prompt from stdin with `-p`. The runner assumes the
  stream uses the same message shapes as transcripts and a final `result` event carrying
  `total_cost_usd`. **Do a single tiny paid smoke run when changing CLI versions**
  (`idriftcheckco record "say ok" --yes`), and fix the adapter if shapes drifted.

## Limits (stated in the README)

- Only the first task is replayed; follow-up human turns are not simulated.
- Runs are non-deterministic: 4+ per side for significance.
- External state (network, databases, MCP side effects) is not reproduced.
- Every real replay is a paid run; hence estimates, confirmation and `--max-cost`.
- Uncommitted changes in the user's checkout are not carried into the worktree.
- Hooks, plugins and project instructions on the user's machine can leak into a run
  unless `--bare` / `--setting-sources` are pinned; the permission mode defaults to
  `acceptEdits`, which can block commands the original session ran (set `permissionMode`
  in the config if the task needs them, ideally inside a container).
