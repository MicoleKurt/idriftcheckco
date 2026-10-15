# Changelog

## 0.2.0 (unreleased)

- `--runs auto`: adaptive run counts with a group-sequential design (Bonferroni alpha
  spending, looks at 5, 7, 8 runs per side by default). Stops early on a confirmed
  regression or when there is no sign of a difference; arms run interleaved. An obvious
  regression now costs 10 runs instead of 16. `--max-runs` and config `maxRuns`.
- HTML report: each run expands to the ordered list of what it did (tool, target,
  errors), capped at 80 steps.
- Release workflow with npm trusted publishing and provenance; RELEASING.md.
- Engineering plan for this release in docs/plans/v0.2.md, including a scan speed-up
  that was measured, found to be noise, and reverted.

## 0.1.0 (2026-10-15)

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
- Realistic replays: `--ref auto` replays on the commit the session started from; the
  replay may use the same tools the session used; `--turns all` replays every human turn
  in one resumed agent session. The replay plan states all three before anything runs.
- Agent and check processes run in their own process group; timeouts kill the whole
  tree on Linux, macOS and Windows.
- GitHub Action with PR comment, artifact upload and enforced exit code.
