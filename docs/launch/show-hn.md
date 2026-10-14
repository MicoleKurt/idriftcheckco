# Show HN draft

**Title:** Show HN: idriftcheckco – regression tests for AI agents, from sessions you already have

**URL:** https://github.com/MicoleKurt/idriftcheckco

---

**Post body**

Every time I swapped the model behind a coding agent, I had the same worry: it still
finishes and still sounds sure of itself, but did it stop running the tests? Did it edit
a different file? Did it get twice as expensive? I had no way to know except reading
transcripts.

Eval platforms answer this if you first write a dataset. But I already had one: the
sessions my agent had run. So idriftcheckco does this:

1. `npx idriftcheckco` finds your existing sessions and ranks them by how well they suit
   an automated re-run (single prompt, changed files, ran its own tests).
2. `replay` re-runs a task in a throwaway git worktree, N times for the unchanged setup
   (the control) and N times with your change (new model, edited prompt/instructions
   file, different MCP config).
3. It diffs the runs: files changed (from `git diff`, not from what the agent claims),
   whether your check command passes, tool sequence, steps, tokens, cost, time.

You can see a full report with no API key: `npx idriftcheckco demo` replays a scripted
agent through the real worktree/diff/statistics pipeline.

Things I tried to get right:

- **Variance.** One run proves nothing, so every finding is marked confirmed or
  unconfirmed. With exact permutation tests, 3 runs per side can never reach p < 0.05
  (the smallest possible p is 0.10), and the tool says so and tells you how many runs you need.
- **Hard vs soft.** Different files / failing check / agent not finishing are "hard".
  Cost, steps, tool order are "soft". A dropped `pnpm test` is called out by name.
- **Local-first.** No telemetry, no accounts. The only network traffic is your own agent
  CLI calling your model provider. Secrets and home paths are redacted when sessions are
  imported. The HTML report is a single file with no scripts.
- **Money.** It estimates cost first, requires confirmation, and has a hard `--max-cost`.

Honest limitations: it replays only the first task of a session (follow-up turns are
lost), external state (network, MCP side effects) is not reproduced, the session format
it reads is undocumented and changes (parsing is isolated in one adapter; it parsed 79 of
79 of my own sessions across ~30 versions), and cost numbers are estimates.

It is MIT, one runtime dependency (zod), ships a GitHub Action that comments on PRs and
fails on regression. I would especially like feedback on: the hard/soft split, whether
the "first task only" limitation makes it useless for your workflow, and which other
agents' session formats you would want supported.
