# Roadmap

v0.1 is deliberately narrow: replay the first task of a session under one changed
condition and diff the behavior. Everything below is *out of scope for v0.1*.

## Good first issues

Each is small, has a clear definition of done, and points at the files to start from.

1. **More secret patterns.** Add Stripe (`sk_live_`, `rk_live_`), npm (`npm_...`),
   Twilio and SendGrid key shapes to `RULES` in `src/redact/redact.ts`.
   *Done when:* each has a row in the table in `test/redact.test.ts`, plus a
   "does not redact ordinary text" case for each new pattern.

2. **`scan --since 14d`.** Filter sessions by age. Start in `src/cli/commands/scan.ts`
   and `listSessionFiles` (`src/adapters/discover.ts`, it already returns `mtimeMs`).
   *Done when:* `14d`, `12h`, `2w` parse, bad values give a `UsageError`, and a test
   covers the parsing function.

3. **`--open` for `report` and `replay`.** Open the HTML report in the default
   browser (`start` / `open` / `xdg-open` via `child_process`, no dependency).
   *Done when:* the command is behind a flag, never runs in CI (`process.env.CI`), and
   the URL-building function is unit tested.

4. **`idriftcheckco prune`.** Delete runs older than N days (default 30) from
   `.idriftcheckco/runs/`, with `--dry-run`. Start from `Store.listRunIds` in
   `src/store/store.ts`. *Done when:* it never touches `traces/`, and tests cover
   dry-run and deletion using a temp directory.

5. **`idriftcheckco prices`.** Print the built-in price table, its "as of" date
   (`PRICES_AS_OF`) and any config overrides, so users can audit cost estimates.
   *Done when:* output is a stable table and `--json` is supported.

6. **Unit tests for `src/util/format.ts`.** `fmtMetric`, `pct`, `fmtP`, `stripAnsi` and
   `escapeHtml` are only tested indirectly. *Done when:* a table-driven
   `test/format.test.ts` covers edge cases (NaN, 0, huge values, `<`/`&`/quotes).

7. **JSON Schema export.** `idriftcheckco schema` prints a JSON Schema for the `Trace`
   file format using zod's built-in JSON Schema support, so other tools can validate
   traces. Start in `src/trace/schema.ts`. *Done when:* the output is valid JSON Schema
   and a test validates the demo trace's shape against it.

8. **High-contrast / colour-blind-safe report palette.** Add a
   `prefers-contrast: more` block to the CSS in `src/report/html.ts` and avoid
   conveying meaning by colour alone (icons already differ; check dots and bars).
   *Done when:* a test asserts the media query exists, with a before/after screenshot
   in the PR.

9. **Windows and UNC path handling.** `normalizePath` in `src/trace/classify.ts` should
   handle UNC paths (`\\\\server\\share\\app`) and drive-letter case. *Done when:* new rows
   in `test/classify.test.ts` pass, including the "shared prefix is not inside cwd" case.

10. **Auto-detect `--ref` from the session.** The transcript records `gitBranch` per
    entry. Surface it on the `Trace` (adapter change in `src/adapters/claude-code.ts`)
    and have `replay` print a hint when HEAD is not that branch. *Done when:* the
    fixture gains a `gitBranch`, the adapter test asserts it, and the hint has a CLI test.

## Next (needs design discussion first)

- **Faster `scan` with worker threads.** Parsing is CPU-bound; async concurrency was
  measured at about 3% (v0.2 plan, item 4). Worker threads are the real fix.
- **More adapters** need real transcripts to build against; the project never guesses a
  format. Contributions with sanitized samples from other agent CLIs are welcome.

- **More adapters.** Other agent CLIs' session formats behind the same `Trace` type
  (one file in `src/adapters/` plus a fixture; the core must not change).
- **Sequential testing.** Stop replaying as soon as the result is conclusive, to cut
  cost (needs an alpha-spending rule so peeking does not inflate false positives).
- **Multi-turn replay.** Replay follow-up human turns, optionally with a scripted or
  simulated user.
- **Optional semantic judge.** An opt-in model-graded comparison of final answers, for
  tasks with no `check` command. Must stay opt-in: it spends money and adds subjectivity.
- **Flake detection.** Run the control arm extra times and report which findings also
  appear between identical runs.
- **Trace library.** Tagging, search and a "suite health" view over many tasks.
- **Hosted badge endpoint** with no data retention, as an alternative to publishing a gist.
- **Per-tool argument diffing** (e.g. which command-line flags a command used).
