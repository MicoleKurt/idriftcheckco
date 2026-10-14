# Competitors and gap analysis

Method: web searches + `gh` queries on 2026-10-14. **Not yet verified per repo**
(stars, activity, licences); every row needs a manual pass before the README
comparison table is published. Claims below are from search summaries unless marked.

| Tool | What it is | Replays *existing* Claude Code sessions? | Re-runs under a changed model/prompt/MCP? | Diffs files/cost/steps with variance? |
|---|---|---|---|---|
| **Catacomb** (reported at `realkarych/catacomb`) | Regression testing for Claude Code/Codex agents; old vs new setup, statistical comparison, CI exit code, redacted local evidence | Unclear; appears task-based | Yes (reported) | Yes, statistical (reported) |
| Apache SkyWalking *AI Sessionizer* | Pre-alpha local session reconstruction + metrics | Yes, **view only** (no model re-run) | No | Metrics/change detection only |
| Claude Code plugin evals (official docs) | Evals for plugins with recorded replay mocks | No | Plugin-scoped | Graders on JSON trace |
| MLflow Claude Code tracing | Tracing/observability + skill evals | Traces, not transcripts | Via eval harness | Platform, not zero-config |
| agent-replay, TraceFork, stepfork, pytest-agentreplay, AgentReplay, tool-call-trace-replay, replayproof, TraceForge | SDK-level record/replay for **your own** LLM agent code (LangGraph, custom) | No (need instrumentation) | Swap model in your code | Tool-seq diffs; mostly exact-match, few handle variance |
| Langfuse, Braintrust, LangSmith, Promptfoo, Inspect AI | Eval platforms; datasets, judges, dashboards | No (ingest traces via SDK) | Yes, with dataset | Yes, but you author datasets |

## Status of this analysis

Written from web search summaries on 2026-10-14. **Not yet verified per repository**:
stars, release activity, licences and exact capabilities of the small projects listed.
One tool described as directly overlapping could not be opened at the reported URL
(404 from both the GitHub CLI and a web fetch), so its existence and scope are
unconfirmed. Before publishing a named comparison table, check each project by hand and
correct this page. The README compares by *category* for that reason.

## Honest conclusions

1. **Catacomb is the direct overlap and must be evaluated first-hand.** The only link I
   found returned 404 to `gh` and WebFetch, so I could not confirm it exists in that form
   today. If it is real and good, the correct move may be to contribute or differentiate,
   not duplicate.
2. The SDK-level replay tools solve a *different* problem (agents you wrote, instrumented).
   None reads the `~/.claude/projects` transcripts users already have.
3. Eval platforms need a dataset you write. "Replays sessions you already have" is the gap.

## Where idriftcheckco must be clearly better (the bar)

- Zero-config: mines your real sessions, ranks them as replay candidates (self-contained
  task, deterministic-ish, cheap), no dataset to author.
- Variance-aware verdicts (N runs, bootstrap/rank test), never single-sample.
- Separates **hard** regressions (files, errors, failing command) from **soft** drift.
- Semantic tool-sequence alignment (not exact string match): tolerates reordered reads,
  flags dropped verification steps.
- Screenshot-worthy single-file HTML report; PR comment; README badge.
- Honest cost: dry-run estimate before any paid run.
