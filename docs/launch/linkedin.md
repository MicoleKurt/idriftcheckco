# LinkedIn post draft

Attach: `docs/assets/social-preview.png` (or let the link preview render it once it is
uploaded as the repo's social preview).

---

Every time I switched the model behind my coding agent, I had the same worry: it still
finishes, it still sounds confident, but did it quietly stop running the tests? Edit a
different file? Double the bill?

So I built idriftcheckco, an open-source regression tester for AI agents.

Instead of asking you to write an eval dataset, it uses the one you already have: your
past agent sessions. It re-runs a task in an isolated git worktree under the old setup
and the new one (new model, edited prompt, different MCP config), several times each,
and diffs what actually happened:

🔴 Hard differences: different files changed, your test command failing, the agent no longer finishing
🟡 Soft drift: cost, steps, tokens, time, and a test run that silently disappeared

A few things I cared about:
• Honest statistics. With 3 runs per side, nothing can be "significant" (the smallest
  possible p-value is 0.10), so findings are marked confirmed or unconfirmed instead of
  pretending.
• Ground truth from git diff, not from what the agent claims it did.
• Local-first: no telemetry, no account, secrets redacted on import.
• It checks the cost first and refuses to start runs that would fail (for example an
  agent CLI that is not logged in), so you never pay for a useless report.

Try it in about 30 seconds, offline and free (a scripted agent goes through the real
pipeline):
npx github:MicoleKurt/idriftcheckco demo

MIT licensed, TypeScript, one runtime dependency, 260+ tests on Linux and Windows.
Feedback and contributions very welcome; there are 10 good first issues open.

🔗 https://github.com/MicoleKurt/idriftcheckco
📊 Example report: https://micolekurt.github.io/idriftcheckco/demo/

#OpenSource #AI #AIAgents #DeveloperTools #TypeScript #LLM
