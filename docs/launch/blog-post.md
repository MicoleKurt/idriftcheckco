# Your agent upgrade didn't fail. It just stopped checking its work.

*A technical write-up of the design behind idriftcheckco.*

## The failure you cannot see in a transcript

When a model upgrade breaks a coding agent, it rarely crashes. The run still ends with a
confident summary. What changes is behavior: it no longer runs the tests, it edits the
wrong file, it takes twice the tokens. These are regressions in *process*, and a
chat-style eval that grades the final message will not see them.

The data to catch this already exists on your disk: every session your agent has run is
a record of a real task. The idea behind idriftcheckco is to treat those sessions as the
dataset, replay them under a changed condition, and compare *behavior*, not prose.

## Decision 1: re-run the task, don't re-feed the transcript

Feeding a recorded transcript back into a new model tests nothing; the model never gets
to make its own decisions. So replay re-runs the *first task* in a fresh `git worktree`
and lets the agent act. The cost is that follow-up human turns are lost, which is why the
tool ranks single-prompt sessions highest and says so.

Using a worktree gives us the most valuable thing in the whole system: ground truth.
"Which files did it change?" is answered by `git status`, not by parsing what the agent
said it did. Edits made through a shell command, which transcripts cannot show, are
visible in a diff.

## Decision 2: compare against a control, not the original session

A human session has follow-ups and different repo state. Comparing a replay to it
conflates "the model changed" with "a replay differs from real life". So by default we
replay the *unchanged* setup too, and compare control to candidate. It doubles the cost;
`--no-control` exists, and the report says it is a weaker comparison.

## Decision 3: statistics that are honest at n = 3

You can afford three to ten runs, not hundreds. A t-test's assumptions do not hold there,
so we use exact permutation tests (every relabeling of the runs is enumerated when there
are at most 20,000; otherwise a seeded Monte Carlo) and Fisher's exact test for
proportions.

This produces an uncomfortable and useful fact: with three runs per side, even a
perfectly separated result has a smallest possible two-sided p-value of 2 / C(6,3) = 0.10.
Nothing can be significant at 0.05 until four runs per side (2 / 70 = 0.029). Most tools
would quietly print a verdict anyway. We keep a second level of evidence instead:
findings are `confirmed` (p < alpha) or `unconfirmed` (a large effect that cannot be
confirmed at this sample size), and the verdict is `regression` or `likely-regression`
accordingly. The report tells you how many runs would settle it.

## Decision 4: hard vs soft

A different file changing or your check command failing is a *hard* difference: the work
is different. Cost, steps, tokens and wall time are *soft*: the work may be the same, but
it got more expensive. Soft drift can fail a pipeline too (`--fail-on drift`), but it is a
different conversation from "the output changed".

For tool order we deliberately ignore reads and searches. An agent that reads two files
in the opposite order has not regressed. We align only *milestones* (edits by path,
commands by signature like `pnpm run test`, MCP and sub-agent calls) with a longest
common subsequence, and surface one thing by name: a verification command that
disappeared, because that is the most common silent regression.

## Decision 5: treat the transcript format as hostile

The session format is undocumented. Looking at my own machine, entries written by about
thirty different CLI versions in three months, fields appearing and vanishing, a single
API message split across several lines each repeating its token usage (naive summing
overcounts), and branches left behind by rewinds. So one adapter file knows field names;
it validates a minimal subset with loose schemas, ignores what it does not understand,
deduplicates usage by message id, and follows parent links from the final message to drop
abandoned branches. Everything downstream consumes one `Trace` type. It parsed all 79 of
my local sessions; the committed fixtures are synthetic because real transcripts contain
private content.

## What it deliberately does not do

It does not judge answer quality with a model, replay follow-up turns, reproduce external
state, or claim a run is "correct" (it reports `completed`, meaning the agent stopped by
itself, never `success`). Those are on the roadmap or out of scope, and the README lists
them under limitations. A tool that regresses-tests your agent should not overclaim
either.

## Try it

```bash
npx idriftcheckco demo     # offline, free
npx idriftcheckco          # your own sessions
```
