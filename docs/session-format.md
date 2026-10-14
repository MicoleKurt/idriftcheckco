# Session transcript format (observed)

Status: **undocumented, unstable, observed empirically.** Nothing here is a contract.
Survey basis: 82 `.jsonl` files, 124,693 lines, 0 unparsable lines, 30 distinct writer
versions (2.1.197 → 2.1.295), written by CLI and desktop entrypoints. Only keys and
types were inspected; no transcript content is stored in this repo.

## Location and layout

- `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — one file per session. The
  directory name is the session's working directory with path separators replaced by `-`.
- Subagent (sidechain) activity is flagged by `isSidechain: true` and `agentId`;
  some sessions also keep subagent files in nested directories.
- Retention is time-limited (documented default: 30 days, `cleanupPeriodDays` in
  `settings.json`), so `idriftcheckco import` should copy transcripts into `.idriftcheckco/`.
- Sibling state: `~/.claude/file-history/<sessionId>/` (file backups used for rewind),
  `~/.claude/sessions/`, `history.jsonl`.

## Envelope: one JSON object per line, discriminated by `type`

| `type` (count in survey) | Meaning | Needed for Trace? |
|---|---|---|
| `assistant` (41.7k) | One content block per line (see below); carries `message.model`, `message.usage` | yes |
| `user` (24.6k) | Human prompt (`content` string or blocks) **or** tool results (`tool_result` blocks) | yes |
| `attachment` (18.4k) | Injected context (hooks, reminders, file mentions) | partly (context size) |
| `system` (≈2.2k) | `subtype`: `stop_hook_summary`, `api_error`, `compact_boundary`, `local_command`, `model_refusal_fallback` | errors, compaction |
| `queue-operation`, `mode`, `last-prompt`, `custom-title`, `ai-title`, `agent-name`, `pr-link`, `bridge-session`, `atis-latch`, `relocated`, `frame-link`, `artifact-*` | UI/session metadata | no (ignored) |
| `file-history-snapshot`, `file-history-delta` | Rewind bookkeeping; backup paths per edited file | files touched (cross-check) |
| `cost-state` (79) | Running cost counters (`totalCostUSD`, `modelUsage`, durations, lines added/removed) | **unreliable**: often 0; do not trust |

Common envelope fields on message-bearing entries: `uuid`, `parentUuid` (forms the
conversation tree; compaction and rewinds create branches), `sessionId`, `timestamp`
(ISO-8601 UTC), `cwd`, `gitBranch`, `version`, `entrypoint`, `isSidechain`, `userType`,
`slug`. **`version` is absent on ~30% of lines** (metadata types).

## Message content blocks

`assistant.message`: `{ id, model, role, content[], stop_reason, usage, ... }`
- Block types seen: `text`, `thinking` (`thinking`, `signature`), `tool_use`
  (`id`, `name`, `input`, `caller`).
- A single API message (same `message.id`) is split over several lines, one block each;
  `usage` repeats on each line. **Token totals must be deduplicated by `message.id`
  (or `requestId`), or they are overcounted.**
- `usage`: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, `cache_creation{ephemeral_5m/1h_input_tokens}`,
  `server_tool_use{web_search_requests,web_fetch_requests}`, `service_tier`, `speed`,
  `iterations`, `output_tokens_details.thinking_tokens`.
- Other assistant extras: `requestedModel`, `effort`, `isApiErrorMessage`,
  `wireToolInputs` (map `tool_use.id` → raw input; may differ from `block.input`).

`user.message.content`: `string` (2.8k) or blocks: `tool_result` (`tool_use_id`,
`content` string-or-blocks, `is_error`), `text`, `image`, `document`.
Tool results also carry a top-level `toolUseResult` whose shape is **tool-specific and
open-ended** (≈150 distinct keys seen: `stdout`, `stderr`, `interrupted`,
`structuredPatch`, `filePath`, `oldString`/`newString`, `numFiles`, ...).

Tool-call linkage: `tool_use.id` ⇄ `tool_result.tool_use_id`; also `sourceToolAssistantUUID`.

## Tool input shapes (stable-looking ones)

`Bash{command,description,timeout,run_in_background}`, `PowerShell{command,...}`,
`Read{file_path,offset,limit}`, `Grep{pattern,path,glob,output_mode,...}`,
`NotebookEdit{notebook_path,cell_id,new_source,...}`; MCP tools are named
`mcp__<server-id>__<tool>`. Edit/Write inputs were not in the top-by-variety sample; the
adapter must verify them against fixtures (`file_path` + `old_string/new_string` /
`content` is the expectation, not a fact yet).

## Implications for the design

1. **Adapter boundary is mandatory.** 30 writer versions in 3 months, fields appear and
   vanish. Parse with zod `.passthrough()` on a *minimal* required subset; unknown
   `type`s are skipped, never fatal; record `sourceVersion` on each Trace.
2. Build the conversation by following `parentUuid`, pick the leaf of the main
   (non-sidechain) path; surface sidechains as nested steps.
3. Cost: compute from deduped `usage` × a versioned local price table; label it
   *estimated*. Never rely on `cost-state`.
4. "Files touched": derive from `tool_use` inputs of write-type tools, with
   `file-history-*` as a cross-check; Bash-caused changes are only visible via replay's
   git diff, not from transcripts. This is a stated limitation of import-only mode.
5. Redaction happens at import: secrets in `Bash` commands, `env`-looking strings,
   `Authorization` headers, key-shaped tokens, and `.env` file reads.
6. Transcripts contain private content (prompts, file contents, images as base64).
   Importing must be explicit and redacted; fixtures must be synthetic or scrubbed.
