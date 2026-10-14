# Contributing

Thanks for helping. The bar is simple: a stranger should be proud to read your diff.

## Setup

```bash
git clone https://github.com/MicoleKurt/idriftcheckco && cd idriftcheckco
pnpm install
pnpm check          # typecheck + lint + tests; needs no API key and no network
pnpm dev demo       # run the CLI from source
```

Node 20+ and git are required. Tests create throwaway git repositories in your temp
directory.

## Ground rules

- **No feature without a test, no public API without a doc comment.** Diff logic is
  tested table-driven (`test/diff.test.ts`): add a row, not a new file.
- **Core never depends on a vendor format.** Anything that knows a transcript field name
  lives in `src/adapters/`. Everything else consumes the `Trace` type.
- **Validate external input** (files, config, CLI flags) with zod or an explicit check;
  error messages must say what happened *and what to do next*.
- **Minimal dependencies.** The runtime has one (`zod`). A new dependency needs a
  justification in the PR description: what it does, why Node built-ins are not enough,
  its size and maintenance status.
- **Never log or store secrets.** If you touch ingest, extend `src/redact/` with a test.
- **No network calls**, except the user's own agent talking to their model provider.
- **Statistics must stay honest.** If a change makes a finding look more certain, show
  the math in the PR.

## Workflow

1. Open an issue first for anything bigger than a bug fix; small PRs merge faster.
2. Branch, then commit with [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat(diff): ...`, `fix(adapter): ...`, `docs: ...`).
3. `pnpm check` must pass. CI runs it on Node 20, 22 and 24 on Linux and Windows.
4. Record non-obvious tradeoffs in [docs/DECISIONS.md](docs/DECISIONS.md).
5. Ideas beyond v0.1 scope go in [docs/ROADMAP.md](docs/ROADMAP.md), not the PR.

## Where things live

| Path | Responsibility |
|---|---|
| `src/trace/` | The normalized `Trace` type, tool classification, pricing |
| `src/adapters/` | Parse vendor session formats into `Trace`; discover and rank sessions |
| `src/redact/` | Secret and path redaction (applied at ingest) |
| `src/store/` | Plain-JSON storage under `.idriftcheckco/` |
| `src/replay/` | Worktrees, agent runners (real and fake), cost estimate |
| `src/diff/` | Statistics, milestone alignment, hard/soft findings, verdict |
| `src/report/` | Terminal, HTML, Markdown, JSON renderers (pure functions) |
| `src/cli/` | Argument parsing and commands |
| `action/` | GitHub Action |

## Fixtures

Real transcripts contain private content and must never be committed. Fixtures in
`test/fixtures/` are synthetic reproductions of the observed shape. If you add one that
was derived from a real session, hand-edit every string and run it through
`redactString` first; reviewers will check.

## Reporting a security issue

See [SECURITY.md](SECURITY.md). Please do not open a public issue.
