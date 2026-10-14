# LinkedIn launch post

Format follows common creator guidance (unofficial): problem-first hook, short paragraphs,
an image, a specific question, and links in the first comment rather than the body.
Attach `docs/assets/social-preview.png`.

## Post

Every time I switched the model behind my coding agent, I had the same worry.

It still finishes. It still sounds confident. But did it quietly stop running the tests? Edit the wrong file? Double the bill?

Eval platforms can answer that, but only after you write a dataset. I realised I already had one: every session my agent had ever run.

So I built idriftcheckco, an open-source regression tester for AI agents.

It re-runs a task from your own past sessions in an isolated git worktree, under the old setup and the new one (new model, edited prompt, different MCP config), several times each. Then it diffs what actually happened:

🔴 Hard regressions: different files changed, your tests failing, the agent no longer finishing
🟡 Soft drift: cost, steps, tokens, time, and test runs that silently disappeared

What I cared about most:

→ Honest statistics. With 3 runs per side, nothing can be significant (the smallest possible p-value is 0.10). So every finding says "confirmed" or "unconfirmed" instead of pretending.
→ Ground truth from git diff, not from what the agent says it did.
→ Local-first. No telemetry, no account, secrets redacted on import.
→ It estimates the cost first and refuses to start runs that are doomed (like an agent CLI that is not logged in), so you never pay for a useless report.

There is a 30-second offline demo that needs no API key, a self-contained HTML report, and a GitHub Action that comments on pull requests.

MIT licensed, TypeScript, one runtime dependency, 260+ tests on Linux and Windows.

Question for anyone running agents in production: when you upgrade the model, what do you check today before you trust it?

Links in the first comment 👇

#OpenSource #AIAgents #DeveloperTools #LLM #TypeScript

## First comment (post right after, then pin it)

Repo, with the 30-second demo (no API key, nothing to install permanently):
https://github.com/MicoleKurt/idriftcheckco

Run it: npx github:MicoleKurt/idriftcheckco demo

Example report from that demo: https://micolekurt.github.io/idriftcheckco/demo/

10 good first issues are open if you would like to contribute.
