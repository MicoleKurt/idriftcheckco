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

## 12. Replay on the commit the session started from (`--ref auto`)
Replaying on today's HEAD compares the new model against code that may have moved on,
so drift from the code would be blamed on the model. The default picks the last commit
on the session's branch before the session's first timestamp (`git rev-list --before`).
Branch names come from untrusted transcripts, so anything option-like is ignored.
Cost: uncommitted work at session time cannot be recovered; the plan says so.

## 13. Grant the replay the tools the session used
A headless agent in `acceptEdits` mode cannot run shell commands, so a replay of a
session that ran its tests could not run them, and the diff would report "stopped
running tests" for a reason that has nothing to do with the model. We pass
`--allowedTools` with exactly the tools observed in the session, identically to every
arm. Shell is granted as a whole tool rather than per command: per-command matching
would deny commands the new model phrases differently, which is the behaviour under
test. Cost: the agent can run arbitrary commands in the worktree, as it could originally.

## 14. Multi-turn replay is opt-in (`--turns all`)
Follow-up prompts were written in reply to the old model's answers ("no, revert that"),
so replaying them verbatim to a new model can be nonsensical. They are still the most
realistic workload for whole-workflow comparisons, so they are replayed in one resumed
session on request. The persisted transcript is deleted afterwards, so replays never
appear in the user's own session list. A failed turn ends the conversation.

## 15. Pre-flight before paid runs
A replay against a logged-out agent CLI produced N failed, paid-for runs and a
misleading report. `auth status` is free and local, so paid runs now refuse to start
when the CLI is missing or logged out.

## 16. Adaptive runs use Bonferroni alpha spending, not SPRT
Sequential probability ratio tests (as in AgentAssay) are the most sample-efficient way
to stop early, but they need a modelled alternative hypothesis for every metric. With
exact small-sample tests already in place, splitting alpha across a few planned looks
(alpha / K at each) keeps the existing statistics, is conservative by construction, and
is easy to explain in one line of the report. Early stopping is allowed for a confirmed
hard regression, or when no adverse effect is present at all; it can lose power but can
never add false positives. Arms are interleaved one run at a time so drift over time
affects both sides equally.

## 17. Concurrent scan parsing was measured and rejected
Bounded-concurrency parsing of session files measured about 3% faster on 40 real
sessions, within noise: parsing is CPU-bound on one thread. The extra code was not worth
it. Worker threads are the right tool if scan speed becomes a problem.

## 18. Releases use npm trusted publishing
Publishing from a laptop needs a passkey each time and an npm login on that machine. A
release workflow with OpenID Connect publishes without any stored token, adds provenance,
and refuses a tag that does not match package.json. The one manual step, linking the
package to the workflow on npmjs.com, is documented in RELEASING.md.
