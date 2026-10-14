# Testing with a fake agent

`--runner fake` replaces the real agent with a deterministic script. It still creates
real git worktrees, really edits files, and runs your real `--check` command, so the
file diff, check result and statistics are genuine. Only the model is absent. This is
how the end-to-end tests and `idriftcheckco demo` run without an API key.

## Scenario file

A JSON object mapping **arm name** to a behaviour (or a list of behaviours, cycled
across runs). Arm names are the variant names: `control` for the baseline arm, and the
value of `--name` (default: the `--model` value) for the candidate.

```json
{
  "control": {
    "actions": [
      { "tool": "Read",  "target": "src/app.js" },
      { "tool": "Edit",  "target": "src/app.js", "content": "// fixed" },
      { "tool": "Bash",  "target": "pnpm test" }
    ],
    "costUsd": 0.2, "durationMs": 30000, "tokens": 20000, "jitter": 0.1
  },
  "new-model": [
    { "actions": [{ "tool": "Edit", "target": "README.md" }], "costUsd": 0.5 },
    { "actions": [{ "tool": "Read", "target": "src/app.js" }], "status": "error" }
  ]
}
```

| Field | Meaning |
|---|---|
| `actions[].tool` | `Read`, `Write`, `Edit`, `Bash`, ... (anything is accepted for categorisation) |
| `actions[].target` | A path, or the command for `Bash` (commands are recorded, **not executed**) |
| `actions[].content` | `Write`: file contents. `Edit`: a line appended to the file |
| `actions[].ok` | `false` marks the call as a tool error and skips its file effect |
| `costUsd`, `durationMs`, `tokens` | Reported metrics, with `jitter` (0 to 1) of seeded noise |
| `status` | `completed` (default), `error`, `interrupted`, `unknown` |

A list of behaviours models an agent that sometimes does something different: with two
behaviours and four runs, runs alternate between them. `--seed <n>` changes the noise.

## Example

```bash
idriftcheckco replay <trace> --model claude-opus-5-5 --name new-model --runs 4 \
  --runner fake --scenario scenario.json --check "pnpm test" --yes
```

See [examples/regression-demo](../examples/regression-demo).
