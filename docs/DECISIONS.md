# Decisions

Non-obvious tradeoffs, newest last. Each entry: what we chose, why, what it costs us.

## 1. One runtime dependency: `zod`
Every external input (transcripts, trace files, config) is untrusted JSON. A schema
library gives us runtime validation, inferred types and readable errors in one place.
Hand-rolling that for ~30 shapes is more code and more bugs than the dependency.
Everything else (CLI parsing, colors, HTML, stats, git) uses Node built-ins.
Dev-only: typescript, vitest, eslint, typescript-eslint, tsx, @types/node.

## 2. TypeScript pinned to 6.x
`typescript-eslint` does not support TypeScript 7 yet. Revisit when it does.

## 3. Transcript format is isolated behind one adapter
Observed 30 writer versions in three months with fields appearing and vanishing
(`docs/session-format.md`). `src/adapters/claude-code.ts` is the only file that knows
vendor field names; it validates a minimal subset with loose objects and skips unknown
entry types. Verified against 79 real local sessions (0 failures) while committing only
synthetic fixtures, because real transcripts contain private content.

## 4. Replay re-runs the task; it does not re-feed the transcript
Re-feeding a recorded transcript would test nothing. See `docs/replay-decision.md`.
Cost: every replay is a paid run, so `--dry-run` and budget caps are first-class.

## 5. Compare control runs, not the original session
A human session has follow-up turns and different repo state; the replay does not.
Comparing a replay against the original session conflates "model changed" with
"replay is different from reality". The default is therefore N control replays
(current config) versus N variant replays. `--no-control` exists for cheap, weaker
comparisons against the original session.

## 6. "completed" is not "succeeded"
`outcome.status` records only that the agent stopped on its own. Correctness comes
from hard signals: files changed (ground truth from `git diff` in the replay worktree)
and an optional user `check` command's exit code. We never label a run "successful".

## 7. Statistics: exact permutation tests, not t-tests
Run counts are tiny (3 to 10). Permutation tests make no distribution assumption and
are exact for small N (enumerated, not sampled, when C(n,k) <= 20 000; seeded Monte
Carlo otherwise, so results are reproducible). Fisher's exact test for proportions.
Consequence we state openly: with 3 vs 3 runs the smallest possible two-sided p is 0.10,
so a verdict can never be "strong" at alpha 0.05 until N >= 4 per arm. Findings with
unanimous-but-untestable evidence are reported as *weak*, not hidden.

## 8. Evidence levels instead of a single pass/fail
Each finding carries `strong` (p < alpha) or `weak` (effect present, not testable at
this N). Verdicts: `regression`, `likely-regression`, `drift`, `possible-drift`,
`no-change`. CI fails on `regression` and `likely-regression` by default.

## 9. Tool-sequence comparison ignores read/search order
Reading files in a different order is noise. Only *milestones* are aligned (LCS):
writes by path, commands by signature (`pnpm run test`), MCP/agent calls. A dropped
verification command is surfaced explicitly; it is the most common silent regression.

## 10. Prices are data, labelled "estimated", overridable
`input`/`output` come from the provider's published table (as of 2026-10-06). The
5-minute cache-write multiplier is assumed (1.25x). Unknown models yield `null` cost
rather than a guess. Costs reported by the agent CLI's own result line take precedence.

## 11. Redaction at ingest, not at display
Secrets and home-directory paths are redacted when data enters the system, so
`.idriftcheckco/` is safe to commit. Pattern based, therefore best-effort; documented.
