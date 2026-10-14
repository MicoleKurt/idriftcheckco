# Changelog

## 0.1.0 (unreleased)

First release.

- Normalized `Trace` type with a Claude Code session adapter (validated against 79
  real sessions), redaction at ingest, and a price table with unknown-model handling.
- Replay in isolated git worktrees with control and candidate arms, N runs per arm,
  ground-truth file diffs, an optional check command, spending cap and cost estimate.
- Variance-aware diff: exact permutation and Fisher tests, hard vs soft findings,
  evidence levels, milestone alignment.
- Terminal, self-contained HTML, Markdown and JSON reports; CI exit codes; README
  badge payload.
- CLI: `scan` (default), `import`, `replay`, `diff`, `report`, `ci`, `record`, `demo`, `doctor`.
- Free pre-flight before paid runs: refuses to start when the agent CLI is missing or
  not logged in, so no money is spent on runs that cannot succeed.
- Agent and check processes run in their own process group; timeouts kill the whole
  tree on Linux, macOS and Windows.
- GitHub Action with PR comment, artifact upload and enforced exit code.
