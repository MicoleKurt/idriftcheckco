# Regression demo

A tiny project with a real bug (`slugify` does not trim or collapse whitespace) and a
real check (`node test.mjs`). The scripted "agent" in `scenario.json` models a model
upgrade that goes wrong:

| | control (old model) | `opus-5-5` (new model) |
|---|---|---|
| Fixes `src/slugify.js` correctly | 4 / 4 runs | 0 / 4 runs |
| Runs the tests afterwards | 4 / 4 runs | 0 / 4 runs |
| Cost per run | ~$0.21 | ~$0.49 |

Nothing here calls a model: the fake agent really edits files in an isolated git
worktree, so the file diff, the check command and the statistics are all real.

## Run it

The quickest way, from anywhere:

```bash
npx idriftcheckco demo
```

To run the same data by hand, copy the example **outside** this repository (replay
isolates runs with `git worktree`, so it needs its own git root):

```bash
cp -r examples/regression-demo /tmp/regression-demo && cd /tmp/regression-demo/repo
git init -q -b main && git add -A && git commit -q -m init
npx idriftcheckco replay ../trace.json --model claude-opus-5-5 --name opus-5-5 --runs 4 \
  --runner fake --scenario ../scenario.json --check "node test.mjs" --yes
```

`--name` labels the candidate arm; the scenario file looks arms up by that label.

You will see a `REGRESSION` verdict with a failing check (`p = 0.029`), a dropped
verification step, and a 127% cost increase, then a path to the HTML report.
